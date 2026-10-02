import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { agentProcessOperationSchema } from "@mate/protocol";
import { expect, it } from "vitest";
import { runScenario, ScenarioFailure } from "../helpers/scenario-evidence.js";
import { waitForScenario } from "../helpers/scenario-driver.js";
import { createScriptedProvider } from "../helpers/scripted-provider.js";
import { scriptedToolResultSchemas } from "../helpers/scripted-tool-results.js";
import {
  readModelCommandFacts,
  readScenarioCommandFacts,
} from "../helpers/scenario-command-facts.js";
import { readScenarioFacts } from "../helpers/scenario-facts.js";

const boundarySchema = z.enum(["before_execute", "before_receipt"]);
const boundaryEventSchema = z.object({
  boundary: boundarySchema,
  operationId: z.string().uuid(),
  agentId: z.string().uuid(),
  operation: agentProcessOperationSchema,
});
const originalCommand = "printf 'once\\n' >> effect-count.txt";
const crashScenarioSchema = z.object({
  boundary: boundarySchema,
  expectedEffect: z.string(),
  expectedInspection: z.string(),
  command: z.string().default(originalCommand),
});

function runCommandCrashScenario(options: z.input<typeof crashScenarioSchema>) {
  const { boundary, expectedEffect, expectedInspection, command } =
    crashScenarioSchema.parse(options);
  const provider = createScriptedProvider({ timeoutMs: 15_000 });
  return runScenario({
    name: `command-crash-${boundary}`,
    provider,
    environment: {
      agents: [{ name: "命令恢复同事" }],
      node: { commandBoundary: boundarySchema.parse(boundary) },
    },
    run: async ({ environment, driver, signal, step, effectFile }) => {
      const [agent] = environment.agents;
      assert.ok(agent);
      // Prepare the synthetic counter before any model work, and register its actual path
      // immediately. Zero effects and forbidden effects both survive assertion-failure cleanup.
      const effect = join(agent.workspace, "effect-count.txt");
      writeFileSync(effect, "", { mode: 0o600, flag: "wx" });
      effectFile("effect-count.txt", effect);
      let operationId = "";
      provider.forAgent(agent, [
        function executeOriginalCommand(request) {
          request.call("process.exec", { command });
        },
        function inspectAfterRecovery(request) {
          expect(readModelCommandFacts(request.payload.input)).toContainEqual(
            expect.objectContaining({
              operationId,
              state: "unknown",
              request: expect.objectContaining({
                agentId: agent.summary.id,
                operation: { kind: "exec", command, cwd: "." },
              }),
            }),
          );
          const original = provider.requests[0];
          assert.ok(original);
          expect(request.sessionId).toBe(original.sessionId);
          expect(request.payload.input.slice(0, original.payload.input.length)).toEqual(
            original.payload.input,
          );
          request.call("process.exec", {
            command:
              "if [ -s effect-count.txt ]; then cat effect-count.txt; else printf 'absent\\n'; fi; printf 'checked\\n' >> recovery-count.txt",
          });
        },
        function finishInspection(request) {
          const result = request.result("process.exec", scriptedToolResultSchemas["process.exec"]);
          expect(result.state).toBe("succeeded");
          expect(result.receipt?.stdout).toBe(expectedInspection);
          request.text("原操作仍未知；已检查原效果，继续工作。");
        },
      ]);
      const target = await driver.sendOwnerMessage(agent, "执行一次可观察的命令。");
      const boundaryEvent = await step(
        "command boundary with durable start and no receipt",
        async () => {
          const match = await environment.node.waitFor(
            /MATE_SCENARIO_COMMAND_BOUNDARY (.*)\n/,
            5000,
            { signal },
          );
          return boundaryEventSchema.parse(JSON.parse(z.string().parse(match[1])));
        },
      );
      operationId = boundaryEvent.operationId;
      expect(boundaryEvent).toEqual({
        boundary,
        operationId,
        agentId: agent.summary.id,
        operation: { kind: "exec", command, cwd: "." },
      });
      const beforeCrash = readScenarioCommandFacts(environment.directory, agent.summary.id);
      expect(beforeCrash.node).toMatchObject([
        { operationId, state: "started", receipt: null, revision: 1 },
      ]);
      expect(beforeCrash.node).toHaveLength(1);
      expect(beforeCrash.control).toMatchObject([
        { operationId, agentId: agent.summary.id, nodeId: environment.nodeId },
      ]);
      expect(beforeCrash.control).toHaveLength(1);
      // A real heartbeat may already have reconciled the still-started node row as unproven.
      // Neither that unknown nor the original intent is a successful command receipt.
      expect(beforeCrash.control[0]?.state).toBeOneOf(["executing", "unknown"]);
      expect(readFileSync(effect, "utf8")).toBe(expectedEffect);
      const oldRun = await driver.waitForRun(target, "running", { signal });
      expect(beforeCrash.control[0]?.runId).toBe(oldRun.id);
      await step("target node killed", async () => {
        const node = environment.node;
        expect(node.child.kill("SIGKILL")).toBe(true);
        await waitForScenario("node SIGKILL exit", () => node.exitStatus, Boolean, { signal });
        expect(node.exitStatus).toEqual({ code: null, signal: "SIGKILL" });
        return node.exitStatus;
      });
      await driver.waitForRun({ ...target, runId: oldRun.id }, "failed", { signal });
      await environment.restartNode();
      await step("original unknown receipt reconciled", () =>
        waitForScenario(
          `unknown receipt for ${operationId}`,
          () => readScenarioCommandFacts(environment.directory, agent.summary.id),
          (facts) =>
            facts.control.some(
              (row) =>
                row.operationId === operationId &&
                row.state === "unknown" &&
                row.nodeReceiptConfirmed === 1,
            ),
          { signal, timeoutMs: 15_000 },
        ),
      );
      const resumed = await driver.waitForRun(target, "completed", { signal, timeoutMs: 15_000 });
      expect(resumed.id).not.toBe(oldRun.id);
      expect(resumed.sessionId).toBe(agent.summary.sessionId);
      expect(readFileSync(effect, "utf8")).toBe(expectedEffect);
      const inspection = join(agent.workspace, "recovery-count.txt");
      effectFile("recovery-count.txt", inspection);
      expect(readFileSync(inspection, "utf8")).toBe("checked\n");
      const afterRecovery = readScenarioCommandFacts(environment.directory, agent.summary.id);
      const originalNode = afterRecovery.node.find((row) => row.operationId === operationId);
      const originalControl = afterRecovery.control.find((row) => row.operationId === operationId);
      expect(originalNode).toMatchObject({
        operationId,
        agentId: agent.summary.id,
        state: "unknown",
        revision: 2,
        receipt: { reason: "node_restarted_during_operation" },
      });
      expect(originalControl).toMatchObject({
        operationId,
        agentId: agent.summary.id,
        nodeId: environment.nodeId,
        runId: oldRun.id,
        state: "unknown",
        nodeReceiptConfirmed: 1,
        nodeReceiptRevision: 2,
        receipt: { reason: "node_restarted_during_operation" },
      });
      expect(originalControl?.request.operation).toEqual(originalNode?.request.operation);
      expect(afterRecovery.node).toHaveLength(2);
      expect(afterRecovery.control).toHaveLength(2);
      expect(
        afterRecovery.node.filter(
          (row) =>
            row.request.operation.kind === "exec" && row.request.operation.command === command,
        ),
      ).toHaveLength(1);
      const facts = readScenarioFacts(environment.directory);
      expect(
        z.object({ id: z.string(), agentId: z.string() }).array().parse(facts.sessions),
      ).toEqual([{ id: agent.summary.sessionId, agentId: agent.summary.id }]);
      expect(
        z
          .object({ state: z.string() })
          .array()
          .parse(facts.runs)
          .filter((run) => run.state === "running"),
      ).toHaveLength(0);
      await provider.assertComplete();
    },
  });
}

it.each(
  crashScenarioSchema.array().parse([
    { boundary: "before_execute", expectedEffect: "", expectedInspection: "absent\n" },
    { boundary: "before_receipt", expectedEffect: "once\n", expectedInspection: "once\n" },
  ]),
)(
  "a node killed at $boundary keeps the operation unknown and permits a fresh inspection",
  runCommandCrashScenario,
  40_000,
);

it("saves a real forbidden command effect before failure cleanup", async () => {
  const failure = await runCommandCrashScenario({
    boundary: "before_receipt",
    expectedEffect: "once\n",
    expectedInspection: "once\n",
    command: "printf 'once\\nonce\\n' >> effect-count.txt",
  }).then(
    () => {
      throw new Error("Expected the independent effect-count assertion to fail");
    },
    (error: unknown) => {
      assert.ok(error instanceof ScenarioFailure);
      return error;
    },
  );
  try {
    expect(failure.cause).toMatchObject({ actual: "once\nonce\n", expected: "once\n" });
    expect(
      readFileSync(join(failure.evidenceDirectory, "effects", "effect-count.txt"), "utf8"),
    ).toBe("once\nonce\n");
    expect(failure.evidenceErrors).toEqual([]);
    expect(failure.cleanup.every((report) => report.failures.length === 0)).toBe(true);
  } finally {
    await failure.close();
    rmSync(failure.evidenceDirectory, { recursive: true, force: true });
  }
}, 40_000);

it.each(["before_execute", "before_receipt"])(
  "a released $boundary command pause finishes the same run without repeating its effect",
  async (boundary) => {
    const provider = createScriptedProvider({ timeoutMs: 15_000 });
    await runScenario({
      name: `command-boundary-release-${boundary}`,
      provider,
      environment: {
        agents: [{ name: "命令暂停同事" }],
        node: { commandBoundary: boundarySchema.parse(boundary) },
      },
      run: async ({ environment, driver, signal, step, effectFile }) => {
        const [agent] = environment.agents;
        assert.ok(agent);
        const effect = join(agent.workspace, "effect-count.txt");
        writeFileSync(effect, "", { mode: 0o600, flag: "wx" });
        effectFile("effect-count.txt", effect);
        provider.forAgent(agent, [
          function executeCommand(request) {
            request.call("process.exec", { command: originalCommand });
          },
          function finishCommand(request) {
            const result = request.result(
              "process.exec",
              scriptedToolResultSchemas["process.exec"],
            );
            expect(result.state).toBe("succeeded");
            expect(result.receipt?.code).toBe(0);
            request.text("命令完成。");
          },
        ]);
        const target = await driver.sendOwnerMessage(agent, "执行一次命令。");
        await environment.node.waitFor(/MATE_SCENARIO_COMMAND_BOUNDARY (.*)\n/, 5000, { signal });
        const run = await driver.waitForRun(target, "running", { signal });
        await step("release the observed command boundary", () => {
          writeFileSync(
            join(environment.directory, "node-data", "command-boundary-release"),
            "release",
            { mode: 0o600 },
          );
          return { runId: run.id, boundary };
        });
        const completed = await driver.waitForRun({ ...target, runId: run.id }, "completed", {
          signal,
        });
        expect(completed.sessionId).toBe(agent.summary.sessionId);
        expect(readFileSync(effect, "utf8")).toBe("once\n");
        const facts = readScenarioCommandFacts(environment.directory, agent.summary.id);
        expect(facts.node).toHaveLength(1);
        expect(facts.node[0]?.state).toBe("succeeded");
        expect(facts.control[0]?.operationId).toBe(facts.node[0]?.operationId);
        await provider.assertComplete();
      },
    });
  },
  40_000,
);
