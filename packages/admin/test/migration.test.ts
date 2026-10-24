import { createPrivateKey, sign } from "node:crypto";
import type { GatewayRunTool } from "@mate/node-protocol";
import { FakeNode, storeFixture } from "@mate/testkit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentEvent } from "../src/index.ts";
import { environment, ok, rendered } from "./support.ts";

describe("upgrading the admin store", () => {
  it("keeps a released Agent home-only after migration", async () => {
    const { dataDirectory, facts } = storeFixture("v0.1.0-alpha.2");
    const env = await environment(dataDirectory);
    const admin = await env.open();
    const { agentId, nodeId } = facts.releasedAgent;
    expect(admin.providers()).toContainEqual(
      expect.objectContaining({
        provider: "openai",
        credentials: { apiKey: `…${facts.openaiApiKey.slice(-4)}`, baseUrl: null },
      }),
    );
    expect(await admin.agents()).toEqual([
      expect.objectContaining({
        agentId,
        nodeId,
        handle: "ada",
        state: "paused",
        grantedNodes: [],
      }),
    ]);
    env.useScriptedProvider(admin);
    admin.renameNode(nodeId, "old-home");
    const calls: GatewayRunTool[] = [];
    const identity = facts.pairedNodes.find((node) => node.nodeId === nodeId);
    if (identity === undefined) throw new Error("released Agent has no recorded node identity");
    const home = new FakeNode({
      gatewayUrl: env.gatewayUrl,
      nodeId,
      sign: (nonce) =>
        sign(null, Buffer.from(nonce), createPrivateKey(identity.privateKey)).toString("base64url"),
      onRunTool: async (call) => {
        calls.push(call);
        return { outputs: [], result: ok("released home answered") };
      },
    });
    onTestFinished(() => home.terminate());
    await home.connect();
    const other = await env.pairNode(admin);
    admin.renameNode(other.nodeId, "new-visit");
    env.provider
      .step("old Agent", (request) => {
        request.call([
          { name: "node_list", arguments: {} },
          { name: "bash", arguments: { command: "pwd" } },
          { name: "bash", arguments: { node: "new-visit", command: "pwd" } },
        ]);
      })
      .step("home-only", (request) => {
        expect(JSON.parse(request.toolOutput("old Agent:0") ?? "null")).toEqual([
          { name: "old-home", online: true, platform: null, home: true },
        ]);
        expect(request.toolOutput("old Agent:1")).toContain("released home answered");
        expect(request.toolOutput("old Agent:2")).toContain("unavailable");
        request.text("The released Agent still uses its home.");
      });
    const account = env.chat.findAccount(agentId);
    if (account === undefined) throw new Error("released Agent has no chat account");
    for (const { timeline } of env.chat.unreadSummary(account).timelines)
      env.chat.readUnread(account, timeline, {
        requestId: `fixture-read:${JSON.stringify(timeline)}`,
      });
    env.post("Check your home, @ada.", [account]);
    await admin.resumeAgent(agentId);
    const events: AgentEvent[] = [];
    const watch = await admin.watchAgent(agentId, (batch) => void events.push(...batch));
    await env.provider.received(2);
    await vi.waitFor(() =>
      expect(rendered(events)).toContain("The released Agent still uses its home."),
    );
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ type: "run_end" })),
    );
    expect(calls).toEqual([expect.objectContaining({ agentId, access: "home" })]);
    expect(other.calls).toEqual([]);
    await watch.stop();
    env.provider.assertComplete();
  });
});
