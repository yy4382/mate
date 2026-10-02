import assert from "node:assert/strict";
import { nodeSummarySchema } from "@mate/protocol/owner";
import { z } from "zod";
import type { ScenarioContext } from "../helpers/scenario-evidence.js";
import { readScenarioFacts } from "../helpers/scenario-facts.js";
import { readNetworkQueueFacts } from "../helpers/scenario-network-facts.js";
import type { createScriptedProvider } from "../helpers/scripted-provider.js";

export const nodeNetworkConfiguration = {
  agents: [{ name: "断网同事" }],
  node: { networkProxy: true, heartbeatTimeoutMs: 1000 },
  controlPlane: { nodeHeartbeatTimeoutMs: 1500 },
};

/** The same model script, link controls and recovery assertions can run in another topology. */
export async function runNodeNetworkRecovery(
  { environment, driver, signal, step }: ScenarioContext,
  provider: ReturnType<typeof createScriptedProvider>,
  mode: "blackhole" | "disconnect",
) {
  const agent = environment.agents[0];
  assert.ok(agent);
  provider.forAgent(agent, [
    function confirmedHistory(request) {
      request.text("已确认历史记号。");
    },
    function pending(request) {
      request.expectCancellation("node offline");
    },
    function resumed(request) {
      assert.equal(request.sessionId, agent?.summary.sessionId);
      assert.match(JSON.stringify(request.payload.input), /网络恢复工作/);
      assert.match(JSON.stringify(request.payload.input), /已确认历史记号/);
      const original = provider.requests.find((candidate) => candidate.step === "pending");
      assert.ok(original);
      assert.deepEqual(
        request.payload.input.slice(0, original.payload.input.length),
        original.payload.input,
      );
      request.text("恢复完成。");
    },
  ]);
  const history = await driver.sendOwnerMessage(agent, "先确认历史");
  await driver.waitForRun(history, "completed", { signal });
  const work = await driver.sendOwnerMessage(agent, "网络恢复工作");
  const pending = await provider.waitFor(agent.summary.id, "pending");
  const oldRun = await driver.waitForRun(work, "running", { signal });
  const after = environment.nodeLink.observe();
  const before = {
    tasks: await driver.tasks(),
    messages: await driver.messages(agent.channelId),
    attachments: await driver.attachments(agent.channelId),
    operations: readScenarioFacts(environment.directory).operations,
  };
  environment.nodeLink[mode]();
  assert.equal(environment.nodeLink.events.at(-1)?.openSockets, 2);
  // An actual Owner workspace preview supplies control-to-node traffic while Pi is pending.
  const preview = environment
    .request(`/api/owner/agents/${agent.summary.id}/workspace?path=.`)
    .then(
      (response) => ({ status: response.status }),
      (error: unknown) => ({ error: String(error) }),
    );
  if (mode === "blackhole")
    await step("bidirectional frames dropped", async () => {
      await environment.nodeLink.waitFor(
        (event) => event.dropped === true && event.direction === "node-to-control",
        { after, signal },
      );
      return environment.nodeLink.waitFor(
        (event) => event.dropped === true && event.direction === "control-to-node",
        { after, signal },
      );
    });
  else await environment.nodeLink.waitFor((event) => event.kind === "closed", { after, signal });
  await step("original run interrupted", async () => {
    const stopped = await driver.waitForRun({ ...work, runId: oldRun.id }, "failed", {
      signal,
    });
    assert.equal(stopped.errorCode, "interrupted");
    const nodes = z
      .object({ nodes: nodeSummarySchema.array() })
      .parse(await (await environment.request("/api/owner/nodes")).json()).nodes;
    assert.equal(nodes.find((node) => node.id === environment.nodeId)?.online, false);
    const events = await driver.activity(agent.summary.id, work.afterActivity, signal);
    assert.ok(events.some((event) => event.kind === "node.disconnected"));
    assert.ok(
      events.some((event) => event.kind === "run.interrupted" && event.referenceId === oldRun.id),
    );
    assert.deepEqual(await pending.outcome, { kind: "cancelled", reason: "node offline" });
    assert.equal(environment.control.exitStatus, undefined);
    assert.equal(environment.node.exitStatus, undefined);
    assert.match(JSON.stringify(await preview), /node_offline|workspace_unavailable|节点/);
    assert.equal(
      pending.call("tasks.create", { messageId: work.message.id, title: "迟到旧任务" }),
      "late",
    );
    assert.equal(
      pending.call("messages.send", { conversationId: agent.channelId, text: "迟到消息" }),
      "late",
    );
    assert.equal(
      pending.call("attachments.publish", {
        conversationId: agent.channelId,
        path: "MEMORY.md",
      }),
      "late",
    );
    assert.equal(pending.call("process.exec", { command: "printf forbidden" }), "late");
    assert.equal(pending.text("迟到正文"), "late");
    assert.deepEqual(await driver.tasks(), before.tasks);
    assert.deepEqual(await driver.messages(agent.channelId), before.messages);
    assert.deepEqual(await driver.attachments(agent.channelId), before.attachments);
    assert.deepEqual(readScenarioFacts(environment.directory).operations, before.operations);
    return stopped;
  });
  await step("reconnect attempt remains blocked until explicit restore", async () => {
    const blocked = await environment.nodeLink.waitFor((event) => event.kind === "blocked", {
      after,
      signal,
    });
    assert.equal(
      environment.nodeLink.events.some(
        (event) => event.sequence > after && event.type === "control.authenticated",
      ),
      false,
    );
    return blocked;
  });
  const cursor = environment.nodeLink.observe();
  environment.nodeLink.restore();
  await environment.nodeLink.waitFor((event) => event.type === "control.authenticated", {
    after: cursor,
    signal,
  });
  await provider.waitFor(agent.summary.id, "resumed");
  const resumedRun = await driver.waitForRun(work, "completed", { signal });
  assert.notEqual(resumedRun.id, oldRun.id);
  assert.equal(resumedRun.sessionId, oldRun.sessionId);
  assert.equal(
    z
      .object({ agentId: z.string() })
      .array()
      .parse(readScenarioFacts(environment.directory).sessions)
      .filter((session) => session.agentId === agent.summary.id).length,
    1,
  );
  assert.equal(readNetworkQueueFacts(environment.directory, agent.summary.id).running.length, 0);
  assert.deepEqual(await driver.tasks(), []);
  await provider.assertComplete();
}
