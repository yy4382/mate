import { readFileSync } from "node:fs";
import type { AccountView, LiveEvents, LiveSnapshot } from "@mate/chat";
import { describe, expect, it } from "vitest";
import { environment, type Browser } from "./support.ts";

const red = readFileSync(
  new URL("../../../tests/fixtures/avatars/red.png", import.meta.url),
).toString("base64");
const blue = readFileSync(
  new URL("../../../tests/fixtures/avatars/blue.png", import.meta.url),
).toString("base64");
const password = "avatar member password";
const avatarPath = (account: AccountView) =>
  `/api/accounts/${account.accountId}/avatar?v=${account.avatarVersion}`;
const save = (browser: Browser, path: string, png: string | null, requestId = "avatar") =>
  browser.request("PUT", path, { requestId, png });

describe("account avatar HTTP operations", () => {
  it("lets humans change their own picture and admins change human or Agent pictures, with login and role checks before the body", async () => {
    const site = await environment().start();
    const admin = site.browser();
    await admin.logInAdmin();
    const added = await admin.post("/api/humans", {
      requestId: "member",
      handle: "mei",
      displayName: "Mei",
      password,
      role: "member",
    });
    const { accountId } = added.json as { accountId: number };
    const member = site.browser();
    await member.logIn("mei", password);
    const own = await save(member, "/api/me/avatar", red);
    expect(own.status, own.text).toBe(200);
    const ownAvatar = own.json as AccountView;
    expect(ownAvatar.accountId).toBe(accountId);
    expect((await site.browser().get(avatarPath(ownAvatar))).status).toBe(401);
    expect((await site.browser().send("PUT", "/api/me/avatar", { body: "not JSON" })).status).toBe(
      401,
    );
    expect(
      (await member.send("PUT", `/api/accounts/${accountId}/avatar`, { body: "not JSON" })).status,
    ).toBe(403);
    expect(
      (await save(admin, `/api/accounts/${accountId}/avatar`, blue, "admin-change")).status,
    ).toBe(200);

    const nodeId = await site.pairNode(admin);
    await admin.request("PUT", "/api/admin/providers/openai/credentials", { apiKey: "unused" });
    const created = await admin.post("/api/admin/agents", {
      nodeId,
      displayName: "Ada",
      handle: "ada",
      settings: { model: { provider: "openai", modelId: "gpt-4.1" } },
    });
    expect(created.status, created.text).toBe(200);
    const snapshot = (await admin.get("/api/chat/snapshot")).json as LiveSnapshot;
    const agent = snapshot.accounts.find((account) => account.handle === "ada")!;
    expect((await save(member, `/api/accounts/${agent.accountId}/avatar`, red)).status).toBe(403);
    const changed = await save(admin, `/api/accounts/${agent.accountId}/avatar`, red);
    expect(changed.status, changed.text).toBe(200);
    expect((await member.get(avatarPath(changed.json as AccountView))).status).toBe(200);
    expect((await save(admin, "/api/accounts/999999/avatar", red)).status).toBe(404);
    expect((await save(admin, "/api/accounts/not-an-id/avatar", red)).status).toBe(400);
    await admin.post(`/api/humans/${accountId}/deactivate`);
    expect((await save(admin, `/api/accounts/${accountId}/avatar`, red, "inactive")).status).toBe(
      403,
    );
  });

  it("serves validated PNG bytes, notifies other clients, replaces the URL, survives restart, and restores the default", async () => {
    const env = environment();
    let site = await env.start();
    const admin = site.browser();
    await admin.logInAdmin();
    const before = (await admin.get("/api/chat/snapshot")).json as LiveSnapshot;
    const stream = await admin.stream(`/api/chat/events?cursor=${before.cursor}`);
    const first = (await save(admin, "/api/me/avatar", red)).json as AccountView;
    const event = await stream.next(
      (event) => event.event === "events" && (event.data as LiveEvents).status === "events",
    );
    expect(event.data).toMatchObject({
      events: [expect.objectContaining({ type: "account", account: first })],
    });
    const response = await fetch(site.url + avatarPath(first), {
      headers: { cookie: admin.cookie! },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const second = (await save(admin, "/api/me/avatar", blue, "replace")).json as AccountView;
    expect(second.avatarVersion).not.toBe(first.avatarVersion);
    expect(
      (await admin.get(avatarPath(first))).status,
      "an old version URL never serves new bytes",
    ).toBe(404);
    stream.cancel();
    await site.close();
    site = await env.start();
    const reopened = site.browser();
    reopened.cookie = admin.cookie;
    const restored = (await reopened.get("/api/chat/snapshot")).json as LiveSnapshot;
    expect(
      restored.accounts.find((account) => account.accountId === second.accountId)?.avatarVersion,
    ).toBe(second.avatarVersion);
    expect((await reopened.get(avatarPath(second))).status).toBe(200);
    expect((await save(reopened, "/api/me/avatar", null, "remove")).json).toMatchObject({
      avatarVersion: null,
    });
    expect((await reopened.get(avatarPath(second))).status).toBe(404);
  });

  it("refuses cross-origin, oversized, malformed, SVG and truncated uploads while keeping the existing picture", async () => {
    const site = await environment().start();
    const admin = site.browser();
    await admin.logInAdmin();
    const original = (await save(admin, "/api/me/avatar", red)).json as AccountView;
    const body = { requestId: "bad", png: blue };
    expect(
      (await admin.request("PUT", "/api/me/avatar", body, { origin: "https://elsewhere.invalid" }))
        .status,
    ).toBe(403);
    expect(
      (
        await admin.send("PUT", "/api/me/avatar", {
          headers: { "content-type": "text/plain" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await admin.send("PUT", "/api/me/avatar", {
          headers: { "content-type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect((await save(admin, "/api/me/avatar", "x".repeat(1024 * 1024), "too-big")).status).toBe(
      413,
    );
    for (const png of [
      "not-base64",
      Buffer.from("<svg></svg>").toString("base64"),
      red.slice(0, -8),
    ]) {
      expect((await save(admin, "/api/me/avatar", png, "invalid-file")).status).toBe(400);
    }
    expect((await admin.get(avatarPath(original))).status).toBe(200);
  });
});
