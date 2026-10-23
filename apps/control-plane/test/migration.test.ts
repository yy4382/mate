import { storeFixture } from "@mate/testkit";
import { describe, expect, it } from "vitest";
import { environment } from "./support.ts";

type Conversation = { conversationId: number; kind: string; name: string | null };

describe("11.1 the control plane on a store written by v0.1.0-alpha.2", () => {
  it("starts on a copy of the fixture's data directory, and the old owner, now an admin, logs in with handle owner and the fixture's password and sees its conversations and unread messages", async () => {
    const env = environment();
    const { facts } = storeFixture("v0.1.0-alpha.2", env.data);
    const site = await env.start();
    const owner = site.browser();

    expect((await owner.logIn("owner", facts.ownerPassword)).status, "the fixture's password").toBe(
      200,
    );
    expect((await site.browser().logIn("owner", "not the fixture password")).status).toBe(401);
    expect(
      (await site.browser().logIn("admin", facts.ownerPassword)).status,
      "the upgrade makes no other human",
    ).toBe(401);

    expect((await owner.get("/api/me")).json).toMatchObject({
      handle: "owner",
      displayName: "Owner",
      role: "admin",
    });
    expect((await owner.get("/api/admin/agents")).status, "an admin").toBe(200);

    const conversations = (await owner.get("/api/chat/conversations")).json as Conversation[];
    expect(conversations.map((c) => [c.kind, c.name]).sort()).toEqual([
      ["dm", null],
      ["dm", null],
      ["public", "general"],
    ]);

    const unread = (await owner.get("/api/chat/unread")).json as {
      total: number;
      mentions: number;
      timelines: unknown[];
    };
    expect({
      total: unread.total,
      mentions: unread.mentions,
      timelines: unread.timelines.length,
    }).toEqual(facts.ownerUnread);

    const general = conversations.find((c) => c.name === "general")!;
    const sent = await owner.post("/api/chat/messages", {
      requestId: "after-upgrade",
      timeline: { conversation: general.conversationId },
      body: "back online",
    });
    expect(sent.status, "the owner can write in the migrated store").toBe(200);
  });

  it("keeps a login session the old version issued working after the upgrade", async () => {
    const env = environment();
    const { facts } = storeFixture("v0.1.0-alpha.2", env.data);
    const site = await env.start();
    const browser = site.browser();
    browser.cookie = `__Host-mate_session=${facts.ownerSessionToken}`;

    expect((await browser.get("/api/me")).json).toMatchObject({ handle: "owner", role: "admin" });
    expect((await browser.get("/api/chat/unread")).status).toBe(200);
    expect((await browser.get("/api/admin/agents")).status, "still an admin").toBe(200);
  });

  it("lets the old owner change their handle and name, and add another human", async () => {
    const env = environment();
    const { facts } = storeFixture("v0.1.0-alpha.2", env.data);
    const site = await env.start();
    const owner = site.browser();
    await owner.logIn("owner", facts.ownerPassword);

    const renamed = await owner.request("PATCH", "/api/me", {
      displayName: "Chris",
      handle: "chris",
    });
    expect(renamed.json).toMatchObject({ handle: "chris", displayName: "Chris", role: "admin" });
    expect((await site.browser().logIn("chris", facts.ownerPassword)).status).toBe(200);

    const added = await owner.post("/api/humans", {
      requestId: "second",
      handle: "sam",
      displayName: "Sam",
      password: "sam has a long password",
      role: "member",
    });
    expect(added.status).toBe(200);
    expect((await site.browser().logIn("sam", "sam has a long password")).status).toBe(200);
  });

  it("keeps the fixture's provider credential, and the fixture's pairing token still pairs a node", async () => {
    const env = environment();
    const { facts } = storeFixture("v0.1.0-alpha.2", env.data);
    const site = await env.start();
    const owner = site.browser();
    await owner.logIn("owner", facts.ownerPassword);

    expect((await owner.get("/api/admin/providers")).json).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        credentials: expect.objectContaining({ apiKey: expect.stringContaining("key") }),
      }),
    );

    const nodeId = await site.pairNode(owner, {}, facts.pairingToken);
    const nodes = (await owner.get("/api/admin/nodes")).json as { nodeId: string }[];
    expect(nodes.map((node) => node.nodeId).sort()).toEqual(
      [...facts.pairedNodes.map((node) => node.nodeId), nodeId].sort(),
    );
  });
});
