import { readDurableEntries } from "../../support/facts/durable-session-facts.js";
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runScenario } from "../../support/scenario/scenario-evidence.js";
import { createScriptedProvider } from "../../support/agent/scripted-provider.js";

import { scriptedToolResultSchemas } from "../../support/agent/scripted-tool-results.js";

import { readRecoveryFacts } from "../../support/facts/scenario-recovery-facts.js";

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
          modelContextWindow: 128000,
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
              prefix: "x".repeat(100000),
              inputTokens: 115000,
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
          const checkpoints = (
            await readDurableEntries(environment.directory, agent.summary.id)
          ).filter((entry) => entry.kind === "pi.compaction");
          expect(checkpoints).toHaveLength(1);
          const checkpoint = checkpoints[0];
          if (checkpoint?.kind !== "pi.compaction")
            throw new Error("Expected confirmed compaction");
          expect(JSON.stringify(checkpoint.model)).toContain(summary.replaceAll("\n", "\\n"));
          return { oldRun, facts };
        });
        await environment.restartControl("SIGKILL");
        await driver.waitForRun(work, "completed", { signal });
        if (completeAnswer) {
          expect(provider.requests).toHaveLength(3);
          const continuation = await driver.sendOwnerMessage(agent, "下一项工作。");
          await driver.waitForRun(continuation, "completed", { signal });
        }
        await step("same checkpoint, interrupted run and confirmed input identity", async () => {
          const facts = readRecoveryFacts(environment.directory, agent.summary.id);
          expect(facts.sessions).toEqual([{ id: work.sessionId }]);
          expect(
            (await readDurableEntries(environment.directory, agent.summary.id)).filter(
              (entry) => entry.kind === "pi.compaction",
            ),
          ).toHaveLength(1);
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
