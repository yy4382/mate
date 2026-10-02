import { expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runScenario } from "../helpers/scenario-evidence.js";
import { createScriptedProvider } from "../helpers/scripted-provider.js";
import { z } from "zod";
import { ownerTaskSchema } from "@mate/protocol/owner";
import { taskToolSchemas } from "../../src/conversations/tool-contracts.js";
import { scriptedToolResultSchemas } from "../helpers/scripted-tool-results.js";
import { waitForScenario } from "../helpers/scenario-driver.js";
import { readRecoveryFacts } from "../helpers/scenario-recovery-facts.js";
import { cpCommitCases, runCpRestart } from "../scenarios/cp-restart.js";

it.each(cpCommitCases)(
  "$id: restores committed history without repeating its command",
  async (boundary) => {
    const provider = createScriptedProvider();
    await runScenario({
      name: boundary.id,
      provider,
      environment: {
        agents: [{ name: "恢复同事" }],
        controlPlane: {
          commitBoundary: { phase: boundary.phase, role: boundary.role, toolName: "process.exec" },
        },
      },
      run: (context) => runCpRestart(context, provider, boundary),
    });
  },
  30_000,
);

it("cp-partial-sse: kills after Pi receives partial tool arguments and recovers no half message", async () => {
  const provider = createScriptedProvider();
  await runScenario({
    name: "cp-partial-sse",
    provider,
    environment: { agents: [{ name: "流恢复同事" }], controlPlane: { observePartialTool: true } },
    async run({ environment, driver, signal, step }) {
      const agent = environment.agents[0];
      if (!agent) throw new Error("Expected prepared Agent");
      provider.forAgent(agent, [
        function partialTool(request) {
          request.expectCancellation("CP SIGKILL after actual tool argument delta");
          request.partialTool('{"name":"process.exec","input":{"command":"touch forbidden"');
        },
        function recoveredAnswer(request) {
          expect(JSON.stringify(request.payload.input)).not.toContain("unfinished");
          expect(request.payload.input).toEqual(provider.requests[0]?.payload.input);
          request.text("恢复后的完整回复。");
        },
      ]);
      const work = await driver.sendOwnerMessage(agent, "恢复流。");
      await step("Pi received tool argument delta", () =>
        environment.control.waitFor(/MATE_CP_PARTIAL (.+)/, 5000, { signal }),
      );
      const oldRun = await driver.waitForRun(work, "running", { signal });
      const oldControl = environment.control;
      await environment.restartControl("SIGKILL");
      expect(oldControl.exitStatus?.signal).toBe("SIGKILL");
      const recovered = await driver.waitForRun(work, "completed", { signal });
      await step("half message absent after confirmed recovery", () => {
        const facts = readRecoveryFacts(environment.directory, agent.summary.id);
        expect(facts.operations).toEqual([]);
        expect(facts.sessions).toEqual([{ id: work.sessionId }]);
        expect(facts.runs.find((run) => run.id === oldRun.id)).toMatchObject({
          state: "failed",
          errorCode: "interrupted",
        });
        expect(JSON.stringify(facts.entries)).not.toContain("unfinished");
        expect(recovered.sessionId).toBe(work.sessionId);
        expect(provider.requests[0]?.call("process.exec", { command: "touch forbidden" })).toBe(
          "late",
        );
        expect(existsSync(join(agent.workspace, "forbidden"))).toBe(false);
        return { recovered, facts };
      });
      expect(await provider.requests[0]?.outcome).toMatchObject({ kind: "cancelled" });
      await provider.assertComplete();
    },
  });
}, 30_000);

it("cp-task-result-before: restores the committed task result and allows an explicit new task", async () => {
  const provider = createScriptedProvider();
  await runScenario({
    name: "cp-task-result-before",
    provider,
    environment: {
      agents: [{ name: "任务恢复同事" }],
      controlPlane: {
        commitBoundary: { phase: "before", role: "toolResult", toolName: "tasks.create" },
      },
    },
    async run({ environment, driver, signal, step }) {
      const agent = environment.agents[0];
      if (!agent) throw new Error("Expected prepared Agent");
      const createResult = z.looseObject({
        task: ownerTaskSchema,
        taskSnapshot: taskToolSchemas["tasks.create"].shape.taskSnapshot.unwrap(),
      });
      provider.forAgent(agent, [
        function readOwner(request) {
          request.call("conversations.read", { conversationId: agent.channelId });
        },
        function createTask(request) {
          const message = request.result(
            "conversations.read",
            scriptedToolResultSchemas["conversations.read"],
          ).messages[0];
          if (!message) throw new Error("Expected actual Owner message");
          request.call("tasks.create", { messageId: message.id, title: "相同标题" });
        },
        function recoverOriginalResult(request) {
          const recovered = request.result("tasks.create", createResult);
          const receipt = readRecoveryFacts(environment.directory, agent.summary.id)
            .taskReceipts[0];
          expect(recovered).toEqual(receipt?.result);
          request.call("tasks.claim", {
            taskId: recovered.task.id,
            expectedVersion: recovered.task.version,
          });
        },
        function explicitlyCreateNewTask(request) {
          expect(
            request.result("tasks.claim", scriptedToolResultSchemas["tasks.claim"]).status,
          ).toBe("in_progress");
          const recovered = request.result("tasks.create", createResult);
          request.call("tasks.create", {
            messageId: recovered.task.messageId,
            title: "明确的新事项",
            taskSnapshot: recovered.taskSnapshot,
          });
        },
        function finish(request) {
          expect(request.result("tasks.create", createResult).task.title).toBe("明确的新事项");
          request.text("本轮结束，任务尚未完成。");
        },
      ]);
      const work = await driver.sendOwnerMessage(agent, "相同标题");
      await step("created task before transcript result commit", () =>
        environment.control.waitFor(/MATE_CP_BOUNDARY (.+)/, 5000, { signal }),
      );
      const oldRun = await driver.waitForRun(work, "running", { signal });
      const committed = await driver.tasks();
      const task = committed[0];
      if (!task) throw new Error("Expected committed task");
      expect(committed).toHaveLength(1);
      expect(task).toMatchObject({
        messageId: work.message.id,
        channelId: agent.channelId,
        ownerAgentId: null,
        status: "open",
      });
      const before = await (
        await environment.request(`/api/owner/tasks/${task.id}/activity`)
      ).json();
      const originalReceipt = readRecoveryFacts(environment.directory, agent.summary.id)
        .taskReceipts[0];
      const initial = provider.requests.at(-1)?.payload.input;
      await environment.restartControl("SIGKILL");
      const resumed = await driver.waitForRun(work, "completed", { signal });
      await step("task identity, creation activity and confirmed result preserved", async () => {
        const tasks = await driver.tasks();
        expect(tasks).toHaveLength(2);
        expect(tasks.find((item) => item.id === task.id)).toMatchObject({
          messageId: task.messageId,
          channelId: task.channelId,
          ownerAgentId: agent.summary.id,
          status: "in_progress",
          version: 2,
        });
        const activity = z
          .object({ events: z.array(z.looseObject({ kind: z.string() })) })
          .parse(await (await environment.request(`/api/owner/tasks/${task.id}/activity`)).json());
        const previousActivity = z
          .object({ events: z.array(z.looseObject({ kind: z.string() })) })
          .parse(before);
        expect(previousActivity.events).toHaveLength(1);
        expect(previousActivity.events[0]?.kind).toBe("created");
        expect(activity.events.filter((event) => event.kind === "created")).toEqual(
          previousActivity.events.filter((event) => event.kind === "created"),
        );
        const facts = readRecoveryFacts(environment.directory, agent.summary.id);
        expect(
          facts.taskReceipts.filter((receipt) => receipt.actionId === originalReceipt?.actionId),
        ).toEqual([originalReceipt]);
        expect(facts.runs.find((run) => run.id === oldRun.id)).toMatchObject({
          state: "failed",
          errorCode: "interrupted",
        });
        expect(facts.sessions).toEqual([{ id: work.sessionId }]);
        expect(resumed.sessionId).toBe(work.sessionId);
        expect(initial).toBeDefined();
        const recoveredRequest = provider.requests.find(
          (request) => request.step === "recoverOriginalResult",
        );
        expect(recoveredRequest?.payload.input.slice(0, initial?.length)).toEqual(initial);
        return { task, originalReceipt, resumed, facts, activity };
      });
      await provider.assertComplete();
    },
  });
}, 30_000);

it.each([false, true])(
  "cp-compacted-%s: preserves confirmed summary and retained history without presenting covered input twice",
  async (completeAnswer) => {
    const provider = createScriptedProvider();
    await runScenario({
      name: completeAnswer ? "cp-compacted-finish" : "cp-compacted-pending-tool",
      provider,
      environment: {
        agents: [{ name: "压缩恢复同事" }],
        controlPlane: {
          modelContextWindow: 16000,
          commitBoundary: completeAnswer
            ? { phase: "finish" }
            : { phase: "after", role: "assistant", toolName: "process.exec" },
        },
      },
      async run({ environment, driver, signal, step, effectFile }) {
        const agent = environment.agents[0];
        if (!agent) throw new Error("Expected prepared Agent");
        const summary = "## Goal\n保留原始输入和已经确认的工具结果。";
        const coveredSeed = "已经持久呈现并压缩的原始输入";
        provider.forAgent(agent, [
          function exceedContext(request) {
            request.tools([{ name: "tools.list", input: {} }], {
              prefix: "x".repeat(28000),
              inputTokens: 15000,
            });
          },
          function confirmedSummary(request) {
            expect(request.kind).toBe("summary");
            request.text(summary);
          },
          function afterCompaction(request) {
            expect(JSON.stringify(request.payload.input)).toContain(
              summary.replaceAll("\n", "\\n"),
            );
            expect(JSON.stringify(request.payload.input)).not.toContain(coveredSeed);
            if (completeAnswer) request.text("完整结束。");
            else
              request.call("process.exec", { command: "printf 'once\\n' >> compacted-effect.txt" });
          },
          function recoveredContext(request) {
            const retained = provider.requests.find((item) => item.step === "afterCompaction")
              ?.payload.input;
            expect(request.payload.input.slice(0, retained?.length)).toEqual(retained);
            expect(JSON.stringify(request.payload.input)).not.toContain(coveredSeed);
            if (!completeAnswer)
              expect(
                request.result("process.exec", scriptedToolResultSchemas["process.exec"]).state,
              ).toBe("succeeded");
            request.text("保留同一摘要继续。");
          },
        ]);
        if (!completeAnswer)
          effectFile("compacted-effect.txt", join(agent.workspace, "compacted-effect.txt"));
        const work = await driver.sendOwnerMessage(agent, coveredSeed);
        const oldRun = await driver.waitForRun(work, "running", { signal });
        await step("confirmed compaction fault point", async () => {
          await environment.control.waitFor(/MATE_CP_BOUNDARY (.+)/, 5000, { signal });
          const facts = readRecoveryFacts(environment.directory, agent.summary.id);
          const checkpoints = facts.entries.filter(({ entry }) => entry.kind === "compaction");
          expect(checkpoints).toHaveLength(1);
          const checkpoint = checkpoints[0]?.entry;
          if (checkpoint?.kind !== "compaction") throw new Error("Expected confirmed compaction");
          expect(checkpoint.summary).toContain(summary);
          return { oldRun, facts };
        });
        await environment.restartControl("SIGKILL");
        await driver.waitForRun(work, "completed", { signal });
        if (completeAnswer) {
          expect(provider.requests).toHaveLength(3);
          const continuation = await driver.sendOwnerMessage(agent, "下一项工作。");
          await driver.waitForRun(continuation, "completed", { signal });
        }
        await step("same checkpoint, interrupted run and confirmed input identity", () => {
          const facts = readRecoveryFacts(environment.directory, agent.summary.id);
          expect(facts.sessions).toEqual([{ id: work.sessionId }]);
          expect(facts.entries.filter(({ entry }) => entry.kind === "compaction")).toHaveLength(1);
          expect(facts.runs.find((run) => run.id === oldRun.id)).toMatchObject({
            state: "failed",
            errorCode: "interrupted",
          });
          expect(
            facts.deliveries.find((delivery) => delivery.messageId === work.message.id),
          ).toMatchObject({ state: "handled" });
          if (!completeAnswer) {
            expect(readFileSync(join(agent.workspace, "compacted-effect.txt"), "utf8")).toBe(
              "once\n",
            );
            expect(facts.operations).toHaveLength(1);
          }
          return facts;
        });
        await provider.assertComplete();
      },
    });
  },
  30_000,
);

it("cp-sigterm-command: a live node command continues after CP exit and its late receipt reconciles once", async () => {
  const provider = createScriptedProvider();
  await runScenario({
    name: "cp-sigterm-command",
    provider,
    environment: {
      agents: [{ name: "关停恢复同事" }],
      // Heartbeats may report unknown while the command runs. Hold only its transcript result.
      controlPlane: {
        commitBoundary: { phase: "before", role: "toolResult", toolName: "process.exec" },
      },
      node: { commandTimeoutMs: 30000 },
    },
    async run({ environment, driver, step, signal, effectFile }) {
      const agent = environment.agents[0];
      if (!agent) throw new Error("Expected prepared Agent");
      provider.forAgent(agent, [
        function runGatedCommand(request) {
          request.call("process.exec", {
            command:
              "printf 'once\\n' >> shutdown-effect.txt; printf '%s' $$ > command-pid; while [ ! -f release-command ]; do sleep 0.025; done; printf 'continued\\n' > command-finished",
          });
        },
        function finishAfterRecovery(request) {
          request.result(
            "process.exec",
            z.object({
              operationId: z.string(),
              state: z.enum(["executing", "succeeded", "failed", "unknown"]),
              receipt: z.unknown(),
            }),
          );
          // The driver holds this real request until the original command's late receipt arrives.
        },
        function readLateReceipt(request) {
          request.call("conversations.read", { conversationId: agent.channelId });
        },
        function finishAfterReceipt(request) {
          const messages = request.result(
            "conversations.read",
            scriptedToolResultSchemas["conversations.read"],
          ).messages;
          expect(
            messages.some(
              (message) =>
                message.text.includes("Mate 已核对操作") && message.text.includes("成功"),
            ),
          ).toBe(true);
          request.text("已读取晚到收据，继续原会话。");
        },
        function completeReceiptMessageRun(request) {
          const correction = z
            .object({
              role: z.literal("user"),
              content: z.array(z.object({ type: z.literal("input_text"), text: z.string() })),
            })
            .parse(request.payload.input.at(-1));
          expect(correction.content[0]?.text).toContain('"state":"succeeded"');
          request.text("这条收据消息已处理。");
        },
      ]);
      effectFile("shutdown-effect.txt", join(agent.workspace, "shutdown-effect.txt"));
      effectFile("command-finished", join(agent.workspace, "command-finished"));
      const work = await driver.sendOwnerMessage(agent, "关停期间的真实命令");
      const oldRun = await driver.waitForRun(work, "running", { signal });
      const before = await step("real effect before command completion", () =>
        waitForScenario(
          "command effect and PID",
          () => ({
            ready: existsSync(join(agent.workspace, "command-pid")),
            facts: readRecoveryFacts(environment.directory, agent.summary.id),
          }),
          (facts) => facts.ready && facts.facts.operations.length === 1,
          { signal },
        ),
      );
      const operation = before.facts.operations[0];
      expect(operation?.state).not.toBe("succeeded");
      expect(existsSync(join(agent.workspace, "command-finished"))).toBe(false);
      const oldControl = environment.control;
      await step("SIGTERM CP exits while node and command survive", async () => {
        await environment.restartControl("SIGTERM");
        expect(oldControl.exitStatus).toEqual({ code: 0, signal: null });
        expect(environment.node.exitStatus).toBeUndefined();
        const commandPid = Number(readFileSync(join(agent.workspace, "command-pid"), "utf8"));
        expect(commandPid).toBeGreaterThan(0);
        process.kill(commandPid, 0);
        expect(existsSync(join(agent.workspace, "command-finished"))).toBe(false);
        return {
          injectedSignal: "SIGTERM",
          exitStatus: oldControl.exitStatus,
          oldRun,
          operation,
          commandPid,
          nodePid: environment.node.child.pid,
        };
      });
      const recovering = await provider.waitFor(agent.summary.id, "finishAfterRecovery");
      writeFileSync(join(agent.workspace, "release-command"), "release\n");
      const receiptMessages = await step(
        "receipt correction is an actual Owner-visible message",
        () =>
          waitForScenario(
            "original operation receipt notification",
            (signal) => driver.messages(agent.channelId, signal),
            (messages) =>
              messages.some(
                (message) =>
                  message.text.includes(`Mate 已核对操作 ${operation?.operationId}`) &&
                  message.text.includes("成功"),
              ),
            { signal },
          ),
      );
      const receiptMessage = receiptMessages.find((message) =>
        message.text.includes(`Mate 已核对操作 ${operation?.operationId}`),
      );
      if (!receiptMessage) throw new Error("Expected actual receipt correction message");
      recovering.text("保留操作事实继续，读取刚到的收据更正。");
      const resumed = await driver.waitForRun(work, "completed", { signal });
      const receiptRun = await driver.waitForRun(
        { ...work, message: receiptMessage },
        "completed",
        { signal },
      );
      await step(
        "late receipt belongs to original operation and cannot authorize its old run",
        async () => {
          const facts = await waitForScenario(
            "original operation late success receipt",
            () => readRecoveryFacts(environment.directory, agent.summary.id),
            (facts) =>
              facts.operations.some(
                (item) => item.operationId === operation?.operationId && item.state === "succeeded",
              ),
            { signal },
          );
          expect(facts.operations).toHaveLength(1);
          expect(facts.operations[0]).toMatchObject({
            operationId: operation?.operationId,
            runId: oldRun.id,
            agentId: agent.summary.id,
            request: operation?.request,
          });
          expect(facts.runs.find((run) => run.id === oldRun.id)).toMatchObject({
            state: "failed",
            errorCode: "interrupted",
          });
          expect(facts.sessions).toEqual([{ id: work.sessionId }]);
          expect(resumed.id).not.toBe(oldRun.id);
          expect(readFileSync(join(agent.workspace, "shutdown-effect.txt"), "utf8")).toBe("once\n");
          expect(readFileSync(join(agent.workspace, "command-finished"), "utf8")).toBe(
            "continued\n",
          );
          expect(receiptRun.sessionId).toBe(work.sessionId);
          return { resumed, receiptRun, facts };
        },
      );
      await provider.assertComplete();
    },
  });
}, 30_000);

it("cp-manual-pause: restart retains Owner pause until explicit resume in the original session", async () => {
  const provider = createScriptedProvider();
  await runScenario({
    name: "cp-manual-pause",
    provider,
    environment: { agents: [{ name: "暂停恢复同事" }] },
    async run({ environment, driver, step, signal }) {
      const agent = environment.agents[0];
      if (!agent) throw new Error("Expected prepared Agent");
      provider.forAgent(agent, [
        function waitForPause(request) {
          request.expectCancellation("Owner manual pause");
        },
        function resumedByOwner(request) {
          const prefix = provider.requests[0]?.payload.input;
          expect(request.payload.input.slice(0, prefix?.length)).toEqual(prefix);
          request.text("原会话恢复。");
        },
      ]);
      const work = await driver.sendOwnerMessage(agent, "保留暂停选择。");
      const pending = await provider.waitFor(agent.summary.id, "waitForPause");
      const oldRun = await driver.waitForRun(work, "running", { signal });
      await environment.request(`/api/owner/agents/${agent.summary.id}/pause`, { method: "POST" });
      expect(await pending.outcome).toMatchObject({ kind: "cancelled" });
      await environment.restartControl("SIGKILL");
      await step("manual pause persists after actual reconnect", async () => {
        const activity = z
          .looseObject({ pausedReason: z.string().nullable() })
          .parse(
            await (
              await environment.request(`/api/owner/agents/${agent.summary.id}/activity`)
            ).json(),
          );
        expect(activity.pausedReason).toBe("manual");
        expect(provider.requests).toHaveLength(1);
        const facts = readRecoveryFacts(environment.directory, agent.summary.id);
        expect(facts.runs.filter((run) => run.state === "running")).toEqual([]);
        expect(facts.runs.find((run) => run.id === oldRun.id)?.state).toBe("failed");
        return { activity, facts };
      });
      await environment.request(`/api/owner/agents/${agent.summary.id}/resume`, { method: "POST" });
      const resumed = await driver.waitForRun(work, "completed", { signal });
      expect(resumed.sessionId).toBe(work.sessionId);
      expect(readRecoveryFacts(environment.directory, agent.summary.id).sessions).toEqual([
        { id: work.sessionId },
      ]);
      await provider.assertComplete();
    },
  });
}, 30_000);
