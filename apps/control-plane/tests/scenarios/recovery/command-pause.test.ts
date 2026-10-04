import { expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runScenario } from "../../support/scenario/scenario-evidence.js";
import { createScriptedProvider } from "../../support/agent/scripted-provider.js";
import { z } from "zod";

import { scriptedToolResultSchemas } from "../../support/agent/scripted-tool-results.js";
import { waitForScenario } from "../../support/scenario/scenario-driver.js";
import { readRecoveryFacts } from "../../support/facts/scenario-recovery-facts.js";

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
