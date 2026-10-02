import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ScenarioContext } from "../helpers/scenario-evidence.js";
import { readRecoveryFacts } from "../helpers/scenario-recovery-facts.js";
import type { createScriptedProvider, ScriptedRequest } from "../helpers/scripted-provider.js";
import { scriptedToolResultSchemas } from "../helpers/scripted-tool-results.js";

export const cpCommitCases = [
  { id: "cp-assistant-before", phase: "before", role: "assistant" },
  { id: "cp-assistant-after", phase: "after", role: "assistant" },
  { id: "cp-result-before", phase: "before", role: "toolResult" },
  { id: "cp-result-after", phase: "after", role: "toolResult" },
] satisfies Array<{ id: string; phase: "before" | "after"; role: "assistant" | "toolResult" }>;
const boundaryEventSchema = z.object({
  phase: z.string(),
  entryId: z.string(),
  role: z.string(),
  toolName: z.string(),
});

/** Selected restart scenario also used by the delivered-container topology. */
export async function runCpRestart(
  context: ScenarioContext,
  provider: ReturnType<typeof createScriptedProvider>,
  boundary = cpCommitCases[1],
) {
  assert.ok(boundary);
  const { environment, driver, step, effectFile, signal } = context;
  const agent = environment.agents[0];
  assert.ok(agent);
  const beforeAssistant = boundary.phase === "before" && boundary.role === "assistant";
  provider.forAgent(agent, [
    function executeOnce(request) {
      request.call("process.exec", { command: "printf 'once\\n' >> effect.txt" });
    },
    ...(beforeAssistant
      ? [
          function retryUncommittedOutput(request: ScriptedRequest) {
            assert.deepEqual(request.payload.input, provider.requests[0]?.payload.input);
            request.call("process.exec", { command: "printf 'once\\n' >> effect.txt" });
          },
        ]
      : []),
    function finishWithReceipt(request) {
      assert.equal(
        request.result("process.exec", scriptedToolResultSchemas["process.exec"]).state,
        "succeeded",
      );
      request.text("完成。");
    },
  ]);
  effectFile("effect.txt", join(agent.workspace, "effect.txt"));
  const work = await driver.sendOwnerMessage(agent, "执行一次并从原会话恢复。");
  const event = await step(boundary.id, async () => {
    const match = await environment.control.waitFor(/MATE_CP_BOUNDARY (.+)/, 5000, { signal });
    return boundaryEventSchema.parse(JSON.parse(z.string().parse(match[1])));
  });
  const oldRun = await driver.waitForRun(work, "running", { signal });
  await step("confirmed history at fault", () => {
    const facts = readRecoveryFacts(environment.directory, agent.summary.id);
    assert.equal(facts.runs.filter((run) => run.state === "running").length, 1);
    assert.equal(
      facts.entries.some(({ entry }) => entry.id === event.entryId),
      boundary.phase === "after",
    );
    assert.equal(existsSync(join(agent.workspace, "effect.txt")), boundary.role === "toolResult");
    return { event, oldRun, facts };
  });
  const oldControl = environment.control;
  await step("SIGKILL exit and same-data restart", async () => {
    await environment.restartControl("SIGKILL");
    assert.equal(oldControl.exitStatus?.signal, "SIGKILL");
    return { exitStatus: oldControl.exitStatus, oldRun };
  });
  const resumed = await driver.waitForRun(work, "completed", { signal });
  await step("original session, interrupted run and one effect", () => {
    const facts = readRecoveryFacts(environment.directory, agent.summary.id);
    assert.deepEqual(facts.sessions, [{ id: work.sessionId }]);
    assert.notEqual(resumed.id, oldRun.id);
    assert.deepEqual(
      facts.runs.find((run) => run.id === oldRun.id),
      { id: oldRun.id, state: "failed", errorCode: "interrupted" },
    );
    assert.ok(facts.runs.filter((run) => run.state === "running").length <= 1);
    assert.equal(facts.operations.length, 1);
    assert.equal(facts.operations[0]?.state, "succeeded");
    assert.equal(readFileSync(join(agent.workspace, "effect.txt"), "utf8"), "once\n");
    const originalInput = provider.requests[0]?.payload.input;
    assert.ok(originalInput);
    for (const request of provider.requests)
      assert.deepEqual(request.payload.input.slice(0, originalInput.length), originalInput);
    return { resumed, facts };
  });
  await provider.assertComplete();
}
