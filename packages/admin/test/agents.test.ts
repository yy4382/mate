import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AdminError } from "../src/index.ts";
import { environment, ok, settings } from "./support.ts";

describe("creating an Agent on a node", () => {
  it("prepares the workspace on the chosen node, and the Agent's commands run there", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const other = await env.pairNode(admin);
    const chosen = await env.pairNode(admin);
    chosen.answer = async () => ({ outputs: ["building\n"], result: ok("built") });

    const { agentId, account } = await env.hire(admin, chosen.nodeId);
    env.provider
      .step(
        "build",
        (request) => void request.call([{ name: "bash", arguments: { command: "make" } }]),
      )
      .step("done", (request) => {
        expect(request.toolOutputs().join(), "the chosen node answered").toContain("built");
        request.text("built it");
      });
    env.post("Build it, @richard.", [account]);
    await env.provider.received(2);

    expect(chosen.prepared, "the workspace is on the chosen node").toEqual([agentId]);
    expect(other.prepared, "and on no other").toEqual([]);
    await vi.waitFor(() => expect(chosen.calls.map((call) => call.agentId)).toEqual([agentId]));
    expect(other.calls, "no command ran elsewhere").toEqual([]);
    expect(await admin.agents()).toEqual([
      expect.objectContaining({ agentId, nodeId: chosen.nodeId, state: "open" }),
    ]);
  });

  it("refuses a node that is not paired, and creates nothing", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);

    await expect(
      admin.createAgent({ nodeId: randomUUID(), displayName: "Lin", handle: "lin", settings }),
    ).rejects.toMatchObject({ reason: "unknown-node" });

    expect(await admin.agents(), "no Agent").toEqual([]);
    expect(env.chat.liveSnapshot(env.owner).accounts, "no chat account but the owner's").toEqual([
      expect.objectContaining({ handle: "owner" }),
    ]);
  });

  it("keeps running an Agent's commands on its node after the control plane restarts", async () => {
    const env = await environment();
    const first = await env.open();
    env.useScriptedProvider(first);
    await env.pairNode(first);
    const chosen = await env.pairNode(first);
    const { agentId, account } = await env.hire(first, chosen.nodeId);
    await first.close();

    const second = await env.open();
    env.provider
      .step("ls", (request) => void request.call([{ name: "bash", arguments: { command: "ls" } }]))
      .step("done", (request) => request.text("listed"));
    env.post("What is there, @richard?", [account]);
    await env.provider.received(2);

    expect(
      chosen.calls.map((call) => call.agentId),
      "the restarted Agent used its node",
    ).toEqual([agentId]);
    await second.close();
    env.provider.assertComplete();
  });
});

describe("listing Agents", () => {
  it("lists each Agent with its chat names, node, state, settings and usage", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const node = await env.pairNode(admin);
    const { agentId: richard, account } = await env.hire(admin, node.nodeId);
    const { agentId: lin } = await env.hire(admin, node.nodeId, {
      displayName: "Lin",
      handle: "lin",
    });
    env.provider.step("notice", (request) => request.text("seen", { inputTokens: 80 }));
    env.post("Morning, @richard.", [account]);
    await env.provider.received(1);
    await admin.pauseAgent(lin);

    const byId = new Map((await admin.agents()).map((agent) => [agent.agentId, agent]));

    expect(byId.get(richard)).toMatchObject({
      displayName: "Richard",
      handle: "richard",
      nodeId: node.nodeId,
      state: "open",
      settings,
    });
    expect(byId.get(lin)).toMatchObject({
      displayName: "Lin",
      handle: "lin",
      nodeId: node.nodeId,
      state: "paused",
      settings,
    });
    await vi.waitFor(async () => {
      const usage = (await admin.agents()).find((agent) => agent.agentId === richard);
      expect(usage, "the usage of the answered request").toMatchObject({
        usage: { models: { "openai/gpt-4.1": { input: 80 } } },
      });
    });
  });

  it("lists an Agent whose file is unreadable with the problem, and the others as they are", async () => {
    const env = await environment();
    const first = await env.open();
    env.useScriptedProvider(first);
    const node = await env.pairNode(first);
    const { agentId } = await env.hire(first, node.nodeId);
    await first.close();
    const broken = randomUUID();
    env.chat.ensureAccount({ externalId: broken, displayName: "Lin", handle: "lin" });
    writeFileSync(join(env.data, "agents", `${broken}.sqlite`), "this is not a database");

    const admin = await env.open();
    const byId = new Map((await admin.agents()).map((agent) => [agent.agentId, agent]));

    expect(byId.get(agentId)).toMatchObject({ state: "open", handle: "richard" });
    expect(byId.get(broken)).toMatchObject({ state: "unreadable", handle: "lin" });
    await admin.deleteAgent(broken);
    expect(
      (await admin.agents()).map((agent) => agent.agentId),
      "deleted",
    ).toEqual([agentId]);
  });
});

describe("pausing, resuming and deleting", () => {
  it("stops the Agent's command on its node when it is paused, and the model learns of it on resume", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const node = await env.pairNode(admin);
    node.answer = () => new Promise(() => undefined);
    const { agentId, account } = await env.hire(admin, node.nodeId);
    env.provider.step(
      "build",
      (request) => void request.call([{ name: "bash", arguments: { command: "make" } }]),
    );
    env.post("Build it, @richard.", [account]);
    await vi.waitFor(() => expect(node.calls, "the command is running").toHaveLength(1));

    await admin.pauseAgent(agentId);

    await vi.waitFor(() =>
      expect(node.stopped, "the node was told to stop it").toEqual([node.calls[0]?.requestId]),
    );
    expect(await admin.agents()).toEqual([expect.objectContaining({ state: "paused" })]);
    env.provider.step("after resume", (request) => {
      expect(request.toolOutputs().join(), "the call did not finish").toMatch(/stopped|interrupt/i);
      request.text("I will check the build");
    });
    await admin.resumeAgent(agentId);
    await env.provider.received(2);
    expect(node.calls, "the command was not run again").toHaveLength(1);
    expect(await admin.agents()).toEqual([expect.objectContaining({ state: "open" })]);
  });

  it("refuses lifecycle calls for an Agent that does not exist", async () => {
    const env = await environment();
    const admin = await env.open();
    const missing = randomUUID();
    for (const call of [
      () => admin.pauseAgent(missing),
      () => admin.resumeAgent(missing),
      () => admin.deleteAgent(missing),
      () => admin.configureAgent(missing, settings),
      () => admin.watchAgent(missing, () => undefined),
    ])
      await expect(call()).rejects.toMatchObject({ reason: "unknown-agent" });
    await expect(admin.pauseAgent("../x")).rejects.toBeInstanceOf(AdminError);
  });

  it("deletes an Agent: it is gone from the list, and its account is deactivated", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const node = await env.pairNode(admin);
    const { agentId, account } = await env.hire(admin, node.nodeId);

    await admin.deleteAgent(agentId);

    expect(await admin.agents()).toEqual([]);
    expect(env.chat.liveSnapshot(env.owner).accounts).toContainEqual(
      expect.objectContaining({ accountId: account, active: false }),
    );
  });
});
