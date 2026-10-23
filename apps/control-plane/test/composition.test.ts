import { ScriptedProvider } from "@mate/testkit";
import { describe, expect, it, onTestFinished } from "vitest";
import { environment, type Browser } from "./support.ts";

const settings = { model: { provider: "openai", modelId: "gpt-4.1" } };

type Snapshot = { cursor: string; accounts: { accountId: number; handle: string }[] };
type Batch = { events: { entry?: { body?: string; author?: number } }[] };

async function scriptedProvider(owner: Browser): Promise<ScriptedProvider> {
  const provider = await ScriptedProvider.start();
  onTestFinished(() => provider.close());
  const saved = await owner.request("PUT", "/api/admin/providers/openai/credentials", {
    apiKey: "sk-test-00000001",
    baseUrl: provider.baseUrl,
  });
  expect(saved.status, "the key is stored").toBe(204);
  return provider;
}

describe("the composed control plane", () => {
  it("an Agent created over HTTP on a paired node answers the owner's DM, which pushes to the owner's browser and reaches the live stream", async () => {
    const env = environment();
    const site = await env.start();
    const owner = site.browser();
    await owner.logInAdmin();
    const provider = await scriptedProvider(owner);
    const nodeId = await site.pairNode(owner);

    const created = await owner.post("/api/admin/agents", {
      nodeId,
      displayName: "Richard",
      handle: "richard",
      settings,
    });
    expect(created.status, created.text).toBe(200);
    const { agentId } = created.json as { agentId: string };
    const snapshot = (await owner.get("/api/chat/snapshot")).json as Snapshot;
    const richard = snapshot.accounts.find((account) => account.handle === "richard");
    expect(richard, "the Agent has a chat account").toBeDefined();

    const endpoint = "https://push.example/owner-phone";
    const keys = {
      p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA",
      auth: "tBHItJI5svbpez7KI4CCXg",
    };
    expect((await owner.post("/api/chat/push/subscribe", { endpoint, keys })).status).toBe(204);
    const dm = (await owner.post("/api/chat/dms", { requestId: "dm", other: richard?.accountId }))
      .json as { conversationId: number };
    const timeline = { conversation: dm.conversationId };
    const stream = await owner.stream(
      `/api/chat/events?cursor=${encodeURIComponent(snapshot.cursor)}`,
    );

    let read: string[] = [];
    let sent: string[] = [];
    provider
      .step("notice", (request) => {
        read = request.call([{ name: "chat_read_unread", arguments: { timeline } }]);
      })
      .step("reply", (request) => {
        expect(request.toolOutput(read[0] ?? ""), "the Agent reads the DM").toContain(
          "Are the backups done?",
        );
        sent = request.call([
          { name: "chat_send", arguments: { timeline, body: "Yes, all three finished." } },
        ]);
      })
      .step("done", (request) => {
        expect(request.toolOutput(sent[0] ?? "")).toContain('"status":"sent"');
        request.text("answered");
      });
    const asked = await owner.post("/api/chat/messages", {
      timeline,
      requestId: "ask",
      body: "Are the backups done?",
    });
    expect(asked.json, "the owner's send skips the freshness check").toMatchObject({
      status: "sent",
    });

    const reply = await stream.next((event) =>
      (event.data as Batch).events?.some((each) => each.entry?.body === "Yes, all three finished."),
    );
    expect(reply.event).toBe("events");
    await provider.received(3);
    provider.assertComplete();
    await expect.poll(() => env.pushes.length, { message: "one push for the reply" }).toBe(1);
    expect(env.pushes[0]?.subscription).toEqual({ endpoint, keys });
    expect(env.pushes[0]?.notice).toMatchObject({ kind: "dm", sender: "richard", ...{ timeline } });

    const agents = (await owner.get("/api/admin/agents")).json;
    expect(agents).toEqual([
      expect.objectContaining({ agentId, nodeId, handle: "richard", state: "open" }),
    ]);
  });

  it("streams an open Agent's conversation, and ends the stream when the Agent is paused", async () => {
    const site = await environment().start();
    const owner = site.browser();
    await owner.logInAdmin();
    await scriptedProvider(owner);
    const nodeId = await site.pairNode(owner);
    const { agentId } = (
      await owner.post("/api/admin/agents", {
        nodeId,
        displayName: "Lin",
        handle: "lin",
        settings,
      })
    ).json as { agentId: string };

    const watch = await owner.stream(`/api/admin/agents/${agentId}/events`);
    const first = await watch.next();
    expect(first.event).toBe("events");
    expect(first.data, "the first batch is a snapshot").toEqual([
      expect.objectContaining({ type: "snapshot" }),
    ]);

    expect((await owner.post(`/api/admin/agents/${agentId}/pause`)).status).toBe(204);
    await watch.ended;
    expect(watch.events.at(-1)?.event).toBe("ended");
    expect((await owner.get("/api/admin/agents")).json).toEqual([
      expect.objectContaining({ agentId, state: "paused" }),
    ]);
    const refused = await owner.get(`/api/admin/agents/${agentId}/events`);
    expect([refused.status, refused.json]).toEqual([
      409,
      expect.objectContaining({ error: "agent-closed" }),
    ]);
  });

  it("keeps the VAPID public key across restarts, and keeps Agents, nodes and keys in the data directory", async () => {
    const env = environment();
    const site = await env.start();
    const owner = site.browser();
    await owner.logInAdmin();
    const key = ((await owner.get("/api/chat/push/key")).json as { publicKey: string }).publicKey;
    expect(key, "a P-256 public key, base64url").toMatch(/^[A-Za-z0-9_-]{87}$/);
    await scriptedProvider(owner);
    const nodeId = await site.pairNode(owner);
    await owner.post("/api/admin/agents", { nodeId, displayName: "Ada", handle: "ada", settings });
    await site.close();

    const again = await env.start();
    const browser = again.browser();
    await browser.logInAdmin();
    expect((await browser.get("/api/chat/push/key")).json).toEqual({ publicKey: key });
    expect((await browser.get("/api/admin/nodes")).json).toEqual([
      expect.objectContaining({ nodeId }),
    ]);
    expect((await browser.get("/api/admin/agents")).json).toEqual([
      expect.objectContaining({ handle: "ada", state: "open" }),
    ]);
    expect((await browser.get("/api/admin/providers")).json).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        credentials: expect.objectContaining({ apiKey: "…0001" }),
      }),
    );
  });
});
