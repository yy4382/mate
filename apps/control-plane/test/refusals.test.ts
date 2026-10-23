import { describe, expect, it } from "vitest";
import { environment, type Browser, type Site } from "./support.ts";

const settings = { model: { provider: "openai", modelId: "gpt-4.1" } };

const refusal = (answer: { status: number; json: unknown }) => [
  answer.status,
  (answer.json as { error?: string } | undefined)?.error,
];

async function signedIn() {
  const site = await environment().start();
  const owner = site.browser();
  await owner.logInAdmin();
  return { site, owner };
}

async function withNode(owner: Browser, site: Site, behaviour?: Parameters<Site["pairNode"]>[1]) {
  await owner.request("PUT", "/api/admin/providers/openai/credentials", { apiKey: "sk-test-0001" });
  return site.pairNode(owner, behaviour);
}

describe("the status of each refusal", () => {
  it("answers 409 archived to a message in an archived channel", async () => {
    const { owner } = await signedIn();
    const { conversationId } = (
      await owner.post("/api/chat/channels", { requestId: "c", name: "old", visibility: "public" })
    ).json as { conversationId: number };
    const archived = await owner.post(`/api/chat/conversations/${conversationId}/archive`, {
      requestId: "a",
    });
    expect(archived.status, archived.text).toBe(200);

    expect(
      refusal(
        await owner.post("/api/chat/messages", {
          timeline: { conversation: conversationId },
          requestId: "m",
          body: "still here?",
        }),
      ),
    ).toEqual([409, "archived"]);
  });

  it("answers 403 not-member to a message in a conversation the owner has left", async () => {
    const { owner } = await signedIn();
    const { conversationId } = (
      await owner.post("/api/chat/channels", { requestId: "c", name: "dev", visibility: "public" })
    ).json as { conversationId: number };
    await owner.post(`/api/chat/conversations/${conversationId}/leave`, { requestId: "l" });

    expect(
      refusal(
        await owner.post("/api/chat/messages", {
          timeline: { conversation: conversationId },
          requestId: "m",
          body: "back again",
        }),
      ),
    ).toEqual([403, "not-member"]);
  });

  it("answers 409 handle-taken, without creating anything, when an Agent asks for a handle in use", async () => {
    const { site, owner } = await signedIn();
    const nodeId = await withNode(owner, site);

    const refused = await owner.post("/api/admin/agents", {
      nodeId,
      displayName: "Second admin",
      handle: "admin",
      settings,
    });

    expect(refusal(refused)).toEqual([409, "handle-taken"]);
    expect(refused.json, "no half-made Agent to finish").not.toHaveProperty("agentId");
    expect((await owner.get("/api/admin/agents")).json).toEqual([]);
  });

  it("answers 400 invalid-input to an Agent with an invalid handle, and 409 agent-exists to a second create with its ID", async () => {
    const { site, owner } = await signedIn();
    const nodeId = await withNode(owner, site);

    expect(
      refusal(
        await owner.post("/api/admin/agents", {
          nodeId,
          displayName: "Lin",
          handle: "not a handle",
          settings,
        }),
      ),
    ).toEqual([400, "invalid-input"]);

    const { agentId } = (
      await owner.post("/api/admin/agents", { nodeId, displayName: "Lin", handle: "lin", settings })
    ).json as { agentId: string };
    expect(
      refusal(
        await owner.post("/api/admin/agents", {
          agentId,
          nodeId,
          displayName: "Other",
          handle: "other",
          settings,
        }),
      ),
    ).toEqual([409, "agent-exists"]);
    expect(
      refusal(
        await owner.post("/api/admin/agents", {
          agentId: "nope",
          nodeId,
          displayName: "L",
          handle: "l",
          settings,
        }),
      ),
      "an agentId that is no Agent ID",
    ).toEqual([400, "invalid-input"]);
  });

  it("answers 500 creation-failed with the agentId when the node cannot prepare the workspace, and the same create finishes once it can", async () => {
    const { site, owner } = await signedIn();
    let broken = true;
    const nodeId = await withNode(owner, site, {
      onPrepareWorkspace: async () => {
        if (broken) throw new Error("disk full");
      },
    });
    const create = (agentId?: string) =>
      owner.post("/api/admin/agents", {
        ...(agentId === undefined ? {} : { agentId }),
        nodeId,
        displayName: "Lin",
        handle: "lin",
        settings,
      });

    const failed = await create();
    expect(refusal(failed)).toEqual([500, "creation-failed"]);
    const { agentId } = failed.json as { agentId: string };
    expect(agentId, "the ID to finish the create with").toMatch(/^[0-9a-f-]{36}$/);
    expect((await owner.get("/api/admin/agents")).json, "no Agent yet").toEqual([]);

    broken = false;
    expect((await create(agentId)).json).toEqual({ agentId });
    expect((await owner.get("/api/admin/agents")).json).toEqual([
      expect.objectContaining({ agentId, handle: "lin", state: "open" }),
    ]);
  });

  it("answers 403 outside-workspace when the node refuses a path, and 404 unknown-agent for a malformed Agent ID", async () => {
    const { site, owner } = await signedIn();
    const nodeId = await withNode(owner, site, {
      onBrowse: async () => ({ ok: false, reason: "outside-workspace", message: "leaves it" }),
    });
    const { agentId } = (
      await owner.post("/api/admin/agents", { nodeId, displayName: "Lin", handle: "lin", settings })
    ).json as { agentId: string };

    expect(refusal(await owner.get(`/api/admin/agents/${agentId}/workspace?path=..%2Fx`))).toEqual([
      403,
      "outside-workspace",
    ]);
    expect(refusal(await owner.post("/api/admin/agents/not-an-id/pause"))).toEqual([
      404,
      "unknown-agent",
    ]);
  });

  it("answers 400 invalid-input to a malformed percent-encoding in a path parameter", async () => {
    const { owner } = await signedIn();

    expect(refusal(await owner.get("/api/admin/agents/%E0%A4%A/assistants"))).toEqual([
      400,
      "invalid-input",
    ]);
    expect(refusal(await owner.request("DELETE", "/api/admin/providers/%/credentials"))).toEqual([
      400,
      "invalid-input",
    ]);
  });
});

describe("requests from another origin", () => {
  it("refuses a body that is not declared as JSON, even with the owner's cookie, and changes nothing", async () => {
    const { owner } = await signedIn();
    const channel = JSON.stringify({ requestId: "c", name: "forged", visibility: "public" });

    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const answer = await owner.send("POST", "/api/chat/channels", {
        headers: { "content-type": type },
        body: channel,
      });
      expect(refusal(answer), type).toEqual([415, "unsupported-media-type"]);
    }
    const noType = await owner.send("POST", "/api/chat/channels", {
      headers: { "content-type": "" },
      body: channel,
    });
    expect(refusal(noType), "no content type").toEqual([415, "unsupported-media-type"]);

    const conversations = (await owner.get("/api/chat/conversations")).json as { name?: string }[];
    expect(
      conversations.map((conversation) => conversation.name),
      "no channel was made",
    ).not.toContain("forged");
    const ok = await owner.send("POST", "/api/chat/channels", {
      headers: { "content-type": "application/json; charset=utf-8" },
      body: channel,
    });
    expect(ok.status, "JSON with a charset is accepted").toBe(200);
  });

  it("refuses a state-changing request whose Origin is not this server, and accepts its own", async () => {
    const { site, owner } = await signedIn();
    const foreign = { origin: "https://evil.example" };

    expect(
      refusal(await owner.request("POST", "/api/admin/pairing-tokens", undefined, foreign)),
      "a body-less POST",
    ).toEqual([403, "cross-origin"]);
    expect(
      refusal(
        await owner.request(
          "POST",
          "/api/chat/channels",
          { requestId: "c", name: "x", visibility: "public" },
          foreign,
        ),
      ),
      "a JSON POST",
    ).toEqual([403, "cross-origin"]);
    expect(
      refusal(
        await owner.request(
          "DELETE",
          "/api/admin/providers/openai/credentials",
          undefined,
          foreign,
        ),
      ),
      "a DELETE",
    ).toEqual([403, "cross-origin"]);
    expect(
      refusal(await owner.request("POST", "/api/logout", undefined, { origin: "null" })),
      "an opaque origin",
    ).toEqual([403, "cross-origin"]);
    expect((await owner.get("/api/chat/unread")).status, "logout did not happen").toBe(200);

    expect(
      (await owner.request("POST", "/api/admin/pairing-tokens", undefined, { origin: site.url }))
        .status,
      "its own origin",
    ).toBe(200);
    expect(
      (await owner.request("POST", "/api/admin/pairing-tokens")).status,
      "no Origin, as from a script or curl",
    ).toBe(200);
  });

  it("refuses a login from another origin too", async () => {
    const site = await environment().start();
    const browser = site.browser();

    const answer = await browser.request(
      "POST",
      "/api/login",
      { password: "anything" },
      { origin: "https://evil.example" },
    );

    expect(refusal(answer)).toEqual([403, "cross-origin"]);
  });
});
