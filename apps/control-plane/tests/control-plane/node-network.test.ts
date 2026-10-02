import assert from "node:assert/strict";
import { it } from "vitest";
import { runScenario } from "../helpers/scenario-evidence.js";
import { waitForScenario, ScenarioWaitError } from "../helpers/scenario-driver.js";
import { createScriptedProvider } from "../helpers/scripted-provider.js";
import { readScenarioFacts } from "../helpers/scenario-facts.js";
import { readNetworkQueueFacts } from "../helpers/scenario-network-facts.js";
import { scriptedToolResultSchemas } from "../helpers/scripted-tool-results.js";
import { z } from "zod";
import { createScenarioNodeLink } from "../helpers/scenario-network.js";
import {
  nodeNetworkConfiguration,
  runNodeNetworkRecovery,
} from "../scenarios/node-network-recovery.js";

it.each(["blackhole", "disconnect"] as const)(
  "interrupts the exact pending run through node %s and restores confirmed history in its original session",
  async (mode) => {
    const provider = createScriptedProvider({ timeoutMs: 15_000 });
    await runScenario({
      name: `node-link-${mode}`,
      provider,
      environment: nodeNetworkConfiguration,
      run: (context) => runNodeNetworkRecovery(context, provider, mode),
    });
  },
  30_000,
);

it("bounds and cancels node-link observation with the last real event and cleans blocked connections", async () => {
  const provider = createScriptedProvider();
  await runScenario({
    name: "node-link-observation-deadlines",
    provider,
    environment: { node: { networkProxy: true } },
    async run({ environment, signal }) {
      const after = environment.nodeLink.observe();
      await assert.rejects(
        environment.nodeLink.waitFor((event) => event.type === "unreachable", {
          after,
          timeoutMs: 50,
          signal,
        }),
        (error: unknown) => {
          assert.ok(error instanceof ScenarioWaitError);
          const facts = z
            .looseObject({
              mode: z.literal("forward"),
              lastEvent: z.looseObject({ sequence: z.number() }),
            })
            .parse(error.lastFacts);
          assert.ok(facts.lastEvent.sequence >= after);
          return true;
        },
      );
      const controller = new AbortController();
      const waiting = environment.nodeLink.waitFor((event) => event.type === "unreachable", {
        after,
        timeoutMs: 1000,
        signal: controller.signal,
      });
      const cancellation = new Error("node link observer cancelled");
      controller.abort(cancellation);
      await assert.rejects(
        waiting,
        (error: unknown) => error instanceof ScenarioWaitError && error.cause === cancellation,
      );
      const startup = new AbortController();
      let registered = false;
      await assert.rejects(
        createScenarioNodeLink(environment.origin, {
          signal: startup.signal,
          registerCleanup(release) {
            environment.registerCleanup("node link cancelled before listen", release);
            registered = true;
            startup.abort(cancellation);
          },
        }),
        (error: unknown) => error === cancellation,
      );
      assert.equal(registered, true);
      environment.nodeLink.disconnect();
      await environment.nodeLink.waitFor((event) => event.kind === "blocked", { after, signal });
      await environment.nodeLink.close();
      assert.throws(() => environment.nodeLink.restore(), /closed/);
    },
  });
}, 30_000);

it("keeps offline messages, due reminders and manual pause while another node continues working", async () => {
  const provider = createScriptedProvider({ timeoutMs: 15_000 });
  await runScenario({
    name: "offline-queue-and-independent-node",
    provider,
    environment: {
      agents: [{ name: "离线队列" }, { name: "人工暂停" }],
      node: { networkProxy: true },
      controlPlane: { nodeHeartbeatTimeoutMs: 600 },
    },
    async run({ environment, driver, signal, step }) {
      const [agent, paused] = environment.agents;
      assert.ok(agent && paused);
      const independentNode = await environment.additionalNode();
      const online = await environment.prepareAgent({ name: "独立在线" }, independentNode.id);
      provider.forAgent(online, [
        function onlineWorks(request) {
          assert.match(JSON.stringify(request.payload.input), /独立在线请求/);
          request.call("process.exec", { command: "printf independent-node" });
        },
        function onlineResult(request) {
          assert.equal(
            request.result("process.exec", scriptedToolResultSchemas["process.exec"]).receipt
              ?.stdout,
            "independent-node",
          );
          request.text("独立工作完成。");
        },
      ]);
      let reminderId = "";
      provider.forAgent(agent, [
        function scheduleReminder(request) {
          request.call("reminders.create", {
            conversationId: agent.channelId,
            text: "离线到期提醒",
            dueAt: Date.now() + 3000,
          });
        },
        function confirmReminder(request) {
          reminderId = request.result("reminders.create", z.looseObject({ id: z.string() })).id;
          request.text("提醒已确认。");
        },
        function interruptedWork(request) {
          request.expectCancellation("queue node offline");
        },
        function recoveredWork(request) {
          assert.equal(request.sessionId, agent.summary.sessionId);
          assert.match(JSON.stringify(request.payload.input), /提醒已确认/);
          assert.match(JSON.stringify(request.payload.input), /离线新消息/);
          assert.match(JSON.stringify(request.payload.input), /离线到期提醒/);
          request.text("队列已接续。");
        },
      ]);
      const setup = await driver.sendOwnerMessage(agent, "设置提醒。");
      await driver.waitForRun(setup, "completed", { signal });
      await environment.request(`/api/owner/agents/${paused.summary.id}/pause`, { method: "POST" });
      const pausedWork = await driver.sendOwnerMessage(paused, "暂停期间保留此消息。");
      const work = await driver.sendOwnerMessage(agent, "待断链工作。");
      const pending = await provider.waitFor(agent.summary.id, "interruptedWork");
      const oldRun = await driver.waitForRun(work, "running", { signal });
      environment.nodeLink.disconnect();
      await driver.waitForRun({ ...work, runId: oldRun.id }, "failed", { signal });
      assert.deepEqual(await pending.outcome, { kind: "cancelled", reason: "queue node offline" });
      assert.equal(
        readNetworkQueueFacts(environment.directory, agent.summary.id).reminders.find(
          (reminder) => reminder.id === reminderId,
        )?.state,
        "active",
        "The reminder must still be active after confirmed offline, before its due firing",
      );
      const queued = await driver.sendOwnerMessage(agent, "离线新消息。");
      await step("due reminder has a persistent pending delivery while offline", () =>
        waitForScenario(
          `reminder ${reminderId} fired offline`,
          () => readNetworkQueueFacts(environment.directory, agent.summary.id),
          (facts) =>
            facts.reminders.some(
              (reminder) =>
                reminder.id === reminderId &&
                reminder.state === "fired" &&
                reminder.deliveryState === "pending",
            ),
          { signal },
        ),
      );
      const onlineWork = await driver.sendOwnerMessage(online, "独立在线请求。");
      await driver.waitForRun(onlineWork, "completed", { signal });
      assert.equal(
        provider.requests.filter((request) => request.agentId === agent.summary.id).length,
        3,
      );
      const after = environment.nodeLink.observe();
      environment.nodeLink.restore();
      await environment.nodeLink.waitFor((event) => event.type === "control.authenticated", {
        after,
        signal,
      });
      await driver.waitForRun(queued, "completed", { signal });
      await step("manual pause remains and its actual queued message is retained", async () => {
        const activity = await (
          await environment.request(`/api/owner/agents/${paused.summary.id}/activity`)
        ).json();
        assert.equal(
          z.looseObject({ pausedReason: z.string() }).parse(activity).pausedReason,
          "manual",
        );
        assert.ok(
          (await driver.messages(paused.channelId)).some(
            (message) => message.id === pausedWork.message.id,
          ),
        );
        assert.equal(
          readNetworkQueueFacts(environment.directory, paused.summary.id).running.length,
          0,
        );
        assert.equal(
          provider.requests.some((request) => request.agentId === paused.summary.id),
          false,
        );
      });
      await provider.assertComplete();
    },
  });
}, 30_000);

it("cancels an actual pending summary, retains the acknowledged checkpoint and rejects its late replacement", async () => {
  const provider = createScriptedProvider({ timeoutMs: 15_000 });
  await runScenario({
    name: "node-link-pending-summary",
    provider,
    environment: {
      agents: [{ name: "摘要接续" }],
      controlPlane: { modelContextWindow: 16000, nodeHeartbeatTimeoutMs: 1500 },
      node: { networkProxy: true, heartbeatTimeoutMs: 1000 },
    },
    async run({ environment, driver, signal, step }) {
      const agent = environment.agents[0];
      assert.ok(agent);
      provider.forAgent(agent, [
        function firstLargeResponse(request) {
          request.tools([{ name: "tools.list", input: {} }], {
            prefix: "x".repeat(28000),
            inputTokens: 15000,
          });
        },
        function confirmedSummary(request) {
          assert.equal(request.kind, "summary");
          request.text("## Goal\n已确认摘要 KEEP-1 保留原工作。");
        },
        function secondLargeResponse(request) {
          assert.equal(request.kind, "normal");
          assert.match(JSON.stringify(request.payload.input), /已确认摘要 KEEP-1/);
          request.tools([{ name: "tools.list", input: {} }], {
            prefix: "y".repeat(28000),
            inputTokens: 15000,
          });
        },
        function pendingSummary(request) {
          assert.equal(request.kind, "summary");
          request.expectCancellation("summary node offline");
        },
        function recoveredSummary(request) {
          assert.equal(request.kind, "summary");
          assert.match(JSON.stringify(request.payload.input), /已确认摘要 KEEP-1/);
          assert.doesNotMatch(JSON.stringify(request.payload.input), /FORBIDDEN/);
          request.text("## Goal\n已确认摘要 KEEP-2 延续原工作。");
        },
        function resumedAfterSummary(request) {
          assert.equal(request.kind, "normal");
          assert.equal(request.sessionId, agent.summary.sessionId);
          assert.match(JSON.stringify(request.payload.input), /已确认摘要 KEEP-2/);
          assert.doesNotMatch(JSON.stringify(request.payload.input), /FORBIDDEN/);
          request.text("摘要恢复完成。");
        },
      ]);
      const work = await driver.sendOwnerMessage(agent, "确认摘要之后再次压缩并接续。");
      const pending = await provider.waitFor(agent.summary.id, "pendingSummary");
      const oldRun = await driver.waitForRun(work, "running", { signal });
      const checkpoints = () =>
        z
          .object({ agentId: z.string(), kind: z.string(), payload: z.string() })
          .array()
          .parse(readScenarioFacts(environment.directory).transcript)
          .filter((record) => record.agentId === agent.summary.id && record.kind === "compaction");
      const confirmed = checkpoints();
      assert.equal(confirmed.length, 1);
      assert.match(JSON.stringify(confirmed), /KEEP-1/);
      const after = environment.nodeLink.observe();
      environment.nodeLink.blackhole();
      const preview = environment
        .request(`/api/owner/agents/${agent.summary.id}/workspace?path=.`)
        .then(
          () => "unexpected preview success",
          (error: unknown) => String(error),
        );
      await environment.nodeLink.waitFor(
        (event) => event.dropped === true && event.direction === "control-to-node",
        { after, signal },
      );
      await environment.nodeLink.waitFor(
        (event) => event.dropped === true && event.direction === "node-to-control",
        { after, signal },
      );
      await step("pending summary cancelled after actual node offline", async () => {
        const stopped = await driver.waitForRun({ ...work, runId: oldRun.id }, "failed", {
          signal,
        });
        assert.equal(stopped.errorCode, "interrupted");
        assert.deepEqual(await pending.outcome, {
          kind: "cancelled",
          reason: "summary node offline",
        });
        const lateRelease = await pending.releaseLate("## Goal\n未确认摘要 FORBIDDEN");
        assert.equal(lateRelease.clientClosed, true);
        assert.equal(lateRelease.responseDestroyed, true);
        assert.deepEqual(lateRelease.writesAccepted, [false]);
        assert.equal(lateRelease.ended, true);
        assert.deepEqual(await pending.outcome, {
          kind: "cancelled",
          reason: "summary node offline",
        });
        assert.deepEqual(checkpoints(), confirmed);
        assert.equal(environment.control.exitStatus, undefined);
        assert.equal(environment.node.exitStatus, undefined);
        assert.match(await preview, /node_offline|workspace_unavailable|节点/);
        return { stopped, lateRelease };
      });
      await environment.nodeLink.waitFor((event) => event.kind === "blocked", { after, signal });
      const cursor = environment.nodeLink.observe();
      environment.nodeLink.restore();
      await environment.nodeLink.waitFor((event) => event.type === "control.authenticated", {
        after: cursor,
        signal,
      });
      const completed = await driver.waitForRun(work, "completed", { signal });
      assert.notEqual(completed.id, oldRun.id);
      assert.equal(completed.sessionId, oldRun.sessionId);
      assert.equal(
        z
          .object({ id: z.string(), state: z.string() })
          .array()
          .parse(readScenarioFacts(environment.directory).runs)
          .find((run) => run.id === oldRun.id)?.state,
        "failed",
      );
      assert.equal(checkpoints().length, 2);
      assert.deepEqual(checkpoints()[0], confirmed[0]);
      assert.doesNotMatch(JSON.stringify(checkpoints()), /FORBIDDEN/);
      assert.deepEqual(await driver.tasks(), []);
      assert.deepEqual(await driver.attachments(agent.channelId), []);
      assert.deepEqual(readScenarioFacts(environment.directory).operations, []);
      assert.equal((await driver.messages(agent.channelId)).length, 1);
      await provider.assertComplete();
    },
  });
}, 30_000);
