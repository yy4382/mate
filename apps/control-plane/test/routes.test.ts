import { mkdirSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { join } from "node:path";
import { temporaryDirectory } from "@mate/testkit";
import type { NodeStatusResult } from "@mate/admin";
import { describe, expect, it } from "vitest";
import { environment } from "./support.ts";

const refusal = (answer: { status: number; json: unknown }) => [
  answer.status,
  (answer.json as { error?: string } | undefined)?.error,
];

describe("the owner's HTTP operations", () => {
  it("sends once per requestId and maps chat refusals to stable statuses", async () => {
    const site = await environment().start();
    const owner = site.browser();
    await owner.logInAdmin();
    const general = (
      await owner.post("/api/chat/channels", {
        requestId: "c",
        name: "general",
        visibility: "public",
      })
    ).json as { conversationId: number };
    const timeline = { conversation: general.conversationId };
    const message = { timeline, requestId: "m1", body: "hello" };

    const first = await owner.post("/api/chat/messages", message);
    const again = await owner.post("/api/chat/messages", message);
    expect(again.json, "a retried send returns the first result").toEqual(first.json);
    const history = await owner.get(`/api/chat/history?conversation=${general.conversationId}`);
    expect((history.json as { body: string }[]).map((entry) => entry.body)).toEqual(["hello"]);

    expect(refusal(await owner.post("/api/chat/messages", { ...message, body: "other" }))).toEqual([
      409,
      "request-conflict",
    ]);
    expect(
      refusal(
        await owner.post("/api/chat/messages", {
          ...message,
          requestId: "m2",
          timeline: { conversation: 999 },
        }),
      ),
    ).toEqual([404, "not-found"]);
    expect(refusal(await owner.post("/api/chat/messages", { timeline, requestId: "m3" }))).toEqual([
      400,
      "invalid-input",
    ]);
    expect(refusal(await owner.post("/api/chat/messages", ["not", "an", "object"]))).toEqual([
      400,
      "invalid-input",
    ]);
    expect(refusal(await owner.get("/api/chat/history"))).toEqual([400, "invalid-input"]);
    expect(
      refusal(
        await owner.post("/api/chat/push/subscribe", {
          endpoint: "http://push.example/insecure",
          keys: { p256dh: "a", auth: "b" },
        }),
      ),
      "push endpoints must be https",
    ).toEqual([400, "invalid-input"]);
    expect(refusal(await owner.get("/api/chat/nothing-here"))).toEqual([404, "no-route"]);
  });

  it("reads forward and advances the owner's read position", async () => {
    const site = await environment().start();
    const owner = site.browser();
    await owner.logInAdmin();
    const { conversationId } = (
      await owner.post("/api/chat/channels", { requestId: "c", name: "dev", visibility: "private" })
    ).json as { conversationId: number };
    const timeline = { conversation: conversationId };
    await owner.post("/api/chat/messages", { timeline, requestId: "m", body: "note to self" });

    const read = await owner.post("/api/chat/read", { timeline, requestId: "r1" });
    expect(read.status, read.text).toBe(200);
    const snapshot = (await owner.get(`/api/chat/snapshot?conversation=${conversationId}`)).json;
    expect(snapshot).toMatchObject({ page: { timeline, position: 1 } });
  });

  it("maps admin refusals to stable statuses", async () => {
    const site = await environment().start();
    const owner = site.browser();
    await owner.logInAdmin();
    const settings = { model: { provider: "openai", modelId: "gpt-4.1" } };

    expect(refusal(await owner.get("/api/admin/agents/nobody/assistants"))).toEqual([
      404,
      "unknown-agent",
    ]);
    expect(
      refusal(
        await owner.post("/api/admin/agents", {
          nodeId: "unpaired",
          displayName: "Ada",
          handle: "ada",
          settings,
        }),
      ),
    ).toEqual([404, "unknown-node"]);
    expect(
      refusal(await owner.request("PUT", "/api/admin/providers/acme/credentials", { apiKey: "k" })),
    ).toEqual([404, "unknown-provider"]);
    expect(
      refusal(await owner.request("PUT", "/api/admin/providers/openai/credentials", {})),
    ).toEqual([400, "invalid-input"]);
    expect((await owner.get("/api/admin/models")).json, "no key, no models").toEqual([]);
    expect((await owner.get("/api/admin/agents")).json).toEqual([]);
  });

  it("answers a node's WebSocket only on the node path", async () => {
    const site = await environment().start();
    const elsewhere = new WebSocket(`${site.url.replace("http", "ws")}/api/chat/events`);
    const closed = await new Promise<string>((resolve) => {
      elsewhere.onopen = () => resolve("open");
      elsewhere.onerror = () => resolve("refused");
    });
    expect(closed).toBe("refused");
  });

  it("shows node metadata, renames nodes over HTTP, and maps every rename refusal without changing the registry", async () => {
    const site = await environment().start();
    const admin = site.browser();
    await admin.logInAdmin();
    const system = {
      platform: "linux",
      arch: "arm64",
      hostname: "Server",
      osRelease: "6.12",
      version: "v0.1.0",
    };
    const first = await site.pairNode(admin, { system });
    const second = await site.pairNode(admin, { system: { ...system, hostname: "laptop" } });
    const nodes = (await admin.get("/api/admin/nodes")).json as NodeStatusResult[];
    expect(nodes.find((node) => node.nodeId === first)).toMatchObject({
      name: "server",
      online: true,
      system,
    });

    expect(
      (await admin.request("PUT", `/api/admin/nodes/${first}`, { name: "worker" })).status,
    ).toBe(204);
    expect(
      (await admin.request("PUT", `/api/admin/nodes/${first}`, { name: "worker" })).status,
    ).toBe(204);
    const renamed = (await admin.get("/api/admin/nodes")).json as NodeStatusResult[];
    expect(renamed.find((node) => node.nodeId === first)).toEqual({
      ...nodes.find((node) => node.nodeId === first),
      name: "worker",
    });
    for (const body of [{ name: "Bad Name" }, {}, { name: null }, { name: 123 }, null]) {
      expect(refusal(await admin.request("PUT", `/api/admin/nodes/${first}`, body))).toEqual([
        400,
        "invalid-input",
      ]);
    }
    expect(
      refusal(await admin.request("PUT", `/api/admin/nodes/${second}`, { name: "worker" })),
    ).toEqual([409, "name-taken"]);
    expect(
      refusal(await admin.request("PUT", "/api/admin/nodes/missing", { name: "unused" })),
    ).toEqual([404, "unknown-node"]);
    expect((await admin.get("/api/admin/nodes")).json).toEqual(renamed);
    expect(
      (await site.browser().request("PUT", `/api/admin/nodes/${first}`, { name: "anonymous" }))
        .status,
    ).toBe(401);
  });
});

/** GET `path` exactly as written, without the URL normalisation fetch applies. */
function raw(url: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(url);
    get({ hostname, port, path }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += String(chunk)));
      response.on("end", () => resolve(body));
    }).on("error", reject);
  });
}

describe("the web client", () => {
  function built() {
    const directory = join(temporaryDirectory(), "web");
    mkdirSync(directory);
    writeFileSync(join(directory, "..", "secret"), "outside the client");
    mkdirSync(join(directory, "assets"));
    writeFileSync(join(directory, "index.html"), "<!doctype html><title>Mate</title>");
    writeFileSync(join(directory, "assets", "app.js"), "console.log('mate')");
    return directory;
  }

  it("serves its files to anyone, and its app pages after login, routing unknown pages to the app", async () => {
    const site = await environment({ webDirectory: built() }).start();
    const browser = site.browser();

    const script = await browser.get("/assets/app.js");
    expect([script.status, script.headers.get("content-type")]).toEqual([
      200,
      "text/javascript; charset=utf-8",
    ]);
    expect((await browser.get("/login")).text, "the login page is the app").toContain(
      "<title>Mate",
    );
    expect((await browser.get("/")).headers.get("location")).toBe("/app");
    expect((await browser.get("/app/chat")).status, "pages need login").toBe(302);
    for (const path of ["/..%2fsecret", "/assets/..%2f..%2fsecret", "/../secret"])
      expect(await raw(site.url, path), path).not.toContain("outside the client");

    await browser.logInAdmin();
    const page = await browser.get("/app/chat/general");
    expect([page.status, page.text]).toEqual([200, "<!doctype html><title>Mate</title>"]);
  });

  it("answers pages with 404 when the client is not built, and the API still works", async () => {
    const site = await environment().start();
    const browser = site.browser();
    await browser.logInAdmin();
    expect((await browser.get("/app")).status).toBe(404);
    expect((await browser.get("/api/chat/unread")).status).toBe(200);
  });
});
