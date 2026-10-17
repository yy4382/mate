import { FakeNode } from "@mate/testkit";
import { describe, expect, it, onTestFinished } from "vitest";
import { environment, newIdentity } from "./support.ts";

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
});
