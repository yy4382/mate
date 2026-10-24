import { FakeNode } from "@mate/testkit";
import { describe, expect, it, onTestFinished } from "vitest";
import { environment, newIdentity, settings } from "./support.ts";

describe("pairing nodes", () => {
  it("pairs one node with a token, refuses the same token for a second, and lists the paired node online", async () => {
    const env = await environment();
    const admin = await env.open();
    const { pairingToken } = admin.createPairingToken();
    const firstIdentity = newIdentity();
    const first = new FakeNode({ gatewayUrl: env.gatewayUrl, ...firstIdentity, pairingToken });
    const second = new FakeNode({ gatewayUrl: env.gatewayUrl, ...newIdentity(), pairingToken });
    onTestFinished(() => {
      first.terminate();
      second.terminate();
    });

    await first.connect();
    await expect(second.connect(), "the token was used up").rejects.toThrow(/pairing_rejected/);

    expect(admin.nodes()).toEqual([
      expect.objectContaining({ nodeId: firstIdentity.nodeId, online: true }),
    ]);
  });

  it("renames a node through the admin boundary and reads its current name for every Agent", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const first = await env.pairNode(admin);
    const second = await env.pairNode(admin);
    const agentId = await admin.createAgent({
      nodeId: first.nodeId,
      displayName: "Ada",
      handle: "ada",
      settings,
    });
    await admin.pauseAgent(agentId);

    admin.renameNode(first.nodeId, "server");
    admin.renameNode(second.nodeId, "laptop");
    expect(admin.nodes().find((node) => node.nodeId === first.nodeId)).toMatchObject({
      name: "server",
    });
    expect(await admin.agents()).toEqual([
      expect.objectContaining({
        agentId,
        nodeId: first.nodeId,
        nodeName: "server",
        state: "paused",
      }),
    ]);
    admin.renameNode(first.nodeId, "worker");
    admin.renameNode(first.nodeId, "worker");
    expect(await admin.agents()).toEqual([
      expect.objectContaining({ agentId, nodeId: first.nodeId, nodeName: "worker" }),
    ]);
    const before = admin.nodes();
    for (const [nodeId, name, reason] of [
      [first.nodeId, "Not Valid", "invalid-input"],
      [first.nodeId, "laptop", "name-taken"],
      ["missing", "unused", "unknown-node"],
    ] as const) {
      expect(() => admin.renameNode(nodeId, name)).toThrowError(
        expect.objectContaining({ reason }),
      );
      expect(admin.nodes()).toEqual(before);
    }
  });
});
