import { expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runScenario } from "../../support/scenario/scenario-evidence.js";
import { createScriptedProvider } from "../../support/agent/scripted-provider.js";
import { z } from "zod";
import { ownerTaskSchema } from "@mate/protocol/owner";
import { taskToolSchemas } from "../../../src/conversations/tools/contracts.js";
import { scriptedToolResultSchemas } from "../../support/agent/scripted-tool-results.js";

import { readRecoveryFacts } from "../../support/facts/scenario-recovery-facts.js";
import { cpCommitCases, runCpRestart } from "../cp-restart.js";

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
