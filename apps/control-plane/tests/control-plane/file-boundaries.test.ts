import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { z } from "zod";
import { runScenario } from "../helpers/scenario-evidence.js";
import { createScriptedProvider } from "../helpers/scripted-provider.js";
import {
  fileModelCorrections,
  fileBoundarySchema,
  readFileActions,
  readFileBoundary,
  readFileNodeEvents,
  readFileSessionFacts,
  readFileVersion,
} from "../helpers/scenario-file-facts.js";
import { readNodeScenarioFacts } from "../helpers/scenario-facts.js";
import { waitForScenario } from "../helpers/scenario-driver.js";

const original = "revision=original\n";
const edited = "revision=edited\n";

function assertOneSessionAndCurrentRun(directory: string, agentId: string, sessionId: string) {
  const facts = readFileSessionFacts(directory, agentId);
  assert.deepEqual(facts.sessions, [{ id: sessionId, agentId }]);
  assert.ok(facts.runs.filter((run) => run.state === "running").length <= 1);
  for (const [index, run] of facts.runs.entries()) {
    const next = facts.runs[index + 1];
    if (next) {
      assert.ok(run.completedAt !== null, "A new run cannot overlap an unfinished run");
      assert.ok(run.completedAt <= next.startedAt, "Run lifetimes must not overlap");
    }
  }
  return facts;
}

it.each(
  fileBoundarySchema.shape.boundary.options.filter((boundary) => boundary !== "after_receipt"),
)(
  "a node killed at the %s file boundary leaves the old operation unknown and lets the informed Agent inspect and continue the same work",
  async (fault) => {
    const provider = createScriptedProvider({ timeoutMs: 15_000 });
    await runScenario({
      name: `file-${fault}`,
      provider,
      environment: {
        agents: [{ name: "文件恢复同事" }],
        node: { fileBoundary: fault },
      },
      async run({ environment, driver, signal, step, effectFile }) {
        const [agent] = environment.agents;
        assert.ok(agent);
        const path = join(agent.workspace, "revision.txt");
        writeFileSync(path, original, { mode: 0o600 });
        const originalVersion = readFileVersion(path);
        let boundaryVersion = originalVersion;
        const boundaryBytes = fault === "before_execute" ? original : edited;
        const continued = join(agent.workspace, "continued.txt");
        effectFile("revision.txt", path);
        if (fault === "before_receipt") effectFile("continued.txt", continued);
        provider.forAgent(agent, [
          function editFile(request) {
            request.call("workspace.edit", {
              path: "revision.txt",
              expectedHash: createHash("sha256").update(original).digest("hex"),
              oldText: "original",
              newText: "edited",
            });
          },
          function inspectUnknown(request) {
            const boundary = readFileBoundary(environment.directory);
            const correction = fileModelCorrections(request.payload.input).find(
              (fact) => fact.operationId === boundary.operationId,
            );
            assert.ok(correction);
            assert.equal(correction.state, "unknown");
            assert.equal(correction.operation, "workspace.edit");
            assert.deepEqual(correction.request, {
              operation: "workspace.edit",
              input: {
                path: "revision.txt",
                expectedHash: createHash("sha256").update(original).digest("hex"),
                oldText: "original",
                newText: "edited",
              },
            });
            assert.equal(readFileSync(path, "utf8"), boundaryBytes);
            assert.deepEqual(readFileVersion(path), boundaryVersion);
            assertOneSessionAndCurrentRun(
              environment.directory,
              agent.summary.id,
              agent.summary.sessionId,
            );
            const initial = provider.requests[0];
            assert.ok(initial);
            assert.deepEqual(
              request.payload.input.slice(0, initial.payload.input.length),
              initial.payload.input,
            );
            request.call("workspace.read", { path: "revision.txt" });
          },
          function remediate(request) {
            assert.equal(
              request.result("workspace.read", z.object({ content: z.string() })).content,
              boundaryBytes,
            );
            request.call("workspace.write", {
              path: fault === "before_execute" ? "revision.txt" : "continued.txt",
              content:
                fault === "before_execute" ? edited : "checked edited file; work continued\n",
            });
          },
          function finish(request) {
            request.text("已知情检查并完成同一文件工作。");
          },
        ]);
        const work = await driver.sendOwnerMessage(
          agent,
          "编辑文件；遇到未知结果先检查原文件再补救。",
        );
        await step(`durable file boundary ${fault}`, () =>
          environment.node.waitFor(/MATE_SCENARIO_FILE_BOUNDARY /, 5000, { signal }),
        );
        assert.equal(readFileSync(path, "utf8"), boundaryBytes);
        boundaryVersion = readFileVersion(path);
        if (fault === "before_execute") assert.deepEqual(boundaryVersion, originalVersion);
        else assert.notDeepEqual(boundaryVersion, originalVersion);
        const boundary = readFileBoundary(environment.directory);
        assert.equal(boundary.agentId, agent.summary.id);
        const [receipt] = readNodeScenarioFacts(environment.directory).fileReceipts;
        assert.ok(receipt);
        assert.deepEqual(
          {
            operationId: receipt.operationId,
            agentId: receipt.agentId,
            requestHash: receipt.requestHash,
            state: receipt.state,
            revision: receipt.revision,
          },
          {
            operationId: boundary.operationId,
            agentId: agent.summary.id,
            requestHash: boundary.requestHash,
            state: "executing",
            revision: 1,
          },
        );
        assert.equal(receipt.result, undefined);
        const [started] = readFileActions(environment.directory);
        assert.ok(started);
        assert.equal(started.sessionId, agent.summary.sessionId);
        assert.equal(started.agentId, agent.summary.id);
        assert.equal(started.receipt.operationId, boundary.operationId);
        assert.equal(started.receipt.nodeRequestHash, boundary.requestHash);
        assert.equal(started.receipt.state, "executing");
        assertOneSessionAndCurrentRun(
          environment.directory,
          agent.summary.id,
          agent.summary.sessionId,
        );
        environment.node.child.kill("SIGKILL");
        await step("actual SIGKILL exit and interrupted old run", async () => {
          await waitForScenario(
            "killed node exited",
            () => environment.node.exitStatus,
            (fact) => fact !== undefined,
            { signal },
          );
          assert.deepEqual(environment.node.exitStatus, { code: null, signal: "SIGKILL" });
          const run = await driver.waitForRun({ ...work, runId: started.receipt.runId }, "failed", {
            signal,
          });
          assert.equal(run.errorCode, "interrupted");
          return run;
        });
        await environment.restartNode();
        await driver.waitForRun(work, "completed", { signal });
        assert.equal(readFileSync(path, "utf8"), edited);
        if (fault === "before_receipt") {
          assert.deepEqual(readFileVersion(path), boundaryVersion);
          assert.equal(readFileSync(continued, "utf8"), "checked edited file; work continued\n");
        }
        const actions = readFileActions(environment.directory);
        assert.equal(actions.length, 2);
        assert.equal(
          actions.find((action) => action.receipt.operationId === boundary.operationId)?.receipt
            .state,
          "unknown",
        );
        assert.equal(
          actions.find((action) => action.operation === "workspace.write")?.receipt.state,
          "succeeded",
        );
        assertOneSessionAndCurrentRun(
          environment.directory,
          agent.summary.id,
          agent.summary.sessionId,
        );
        const events = readFileNodeEvents(environment.processes);
        assert.equal(
          events.requests.filter((event) => event.operationId === boundary.operationId).length,
          1,
        );
        assert.equal(
          events.executions.filter((event) => event.operationId === boundary.operationId).length,
          fault === "before_execute" ? 0 : 1,
        );
        await provider.assertComplete();
      },
    });
  },
  30_000,
);

it("a durable file receipt withheld from the control plane corrects the informed Agent after a node crash without replacing the file twice", async () => {
  const provider = createScriptedProvider({ timeoutMs: 15_000 });
  await runScenario({
    name: "file-after-receipt",
    provider,
    environment: {
      agents: [{ name: "文件收据同事" }],
      controlPlane: { nodeOperationTimeoutMs: 3000 },
      node: { fileBoundary: "after_receipt" },
    },
    async run({ environment, driver, signal, step, effectFile }) {
      const [agent] = environment.agents;
      assert.ok(agent);
      const path = join(agent.workspace, "revision.txt");
      const continued = join(agent.workspace, "continued.txt");
      writeFileSync(path, original, { mode: 0o600 });
      const originalVersion = readFileVersion(path);
      effectFile("revision.txt", path);
      effectFile("continued.txt", continued);
      provider.forAgent(agent, [
        function editFile(request) {
          request.call("workspace.edit", {
            path: "revision.txt",
            expectedHash: createHash("sha256").update(original).digest("hex"),
            oldText: "original",
            newText: "edited",
          });
        },
        function observeUnknownBeforeNewDecision(request) {
          const boundary = readFileBoundary(environment.directory);
          const [action] = readFileActions(environment.directory);
          assert.ok(action);
          assert.equal(action.receipt.operationId, boundary.operationId);
          assert.equal(action.receipt.state, "unknown");
          assertOneSessionAndCurrentRun(
            environment.directory,
            agent.summary.id,
            agent.summary.sessionId,
          );
          const output = z.object({ type: z.literal("function_call_output"), output: z.string() });
          assert.ok(
            request.payload.input.some((item) => {
              const parsed = output.safeParse(item);
              return parsed.success && parsed.data.output.includes("文件操作结果尚未确认");
            }),
          );
          request.expectCancellation("node killed before terminal file receipt could return");
        },
        function inspectCorrectedReceipt(request) {
          const boundary = readFileBoundary(environment.directory);
          const correction = fileModelCorrections(request.payload.input).find(
            (fact) => fact.operationId === boundary.operationId && fact.state === "succeeded",
          );
          assert.ok(correction, "The real model request must receive the reconciled receipt");
          const receipt = z
            .object({
              receipt: z.object({
                operationId: z.string(),
                nodeRequestHash: z.string(),
                state: z.literal("succeeded"),
                revision: z.literal(2),
                result: z.object({ sha256: z.string() }),
              }),
            })
            .parse(correction).receipt;
          assert.equal(receipt.operationId, boundary.operationId);
          assert.equal(receipt.nodeRequestHash, boundary.requestHash);
          assert.equal(receipt.result.sha256, createHash("sha256").update(edited).digest("hex"));
          assertOneSessionAndCurrentRun(
            environment.directory,
            agent.summary.id,
            agent.summary.sessionId,
          );
          const initial = provider.requests[0];
          assert.ok(initial);
          assert.deepEqual(
            request.payload.input.slice(0, initial.payload.input.length),
            initial.payload.input,
          );
          request.call("workspace.read", { path: "revision.txt" });
        },
        function continueSameWork(request) {
          assert.equal(
            request.result("workspace.read", z.object({ content: z.string() })).content,
            edited,
          );
          request.call("workspace.write", {
            path: "continued.txt",
            content: "reconciled edited file; work continued\n",
          });
        },
        function finish(request) {
          request.text("原文件收据已更正，同一工作正常继续。");
        },
      ]);
      const work = await driver.sendOwnerMessage(
        agent,
        "编辑文件并在恢复后检查收据，继续同一工作。",
      );
      await step("terminal file receipt persisted before wire response", async () => {
        await environment.node.waitFor(/MATE_SCENARIO_FILE_BOUNDARY /, 5000, { signal });
        const boundary = readFileBoundary(environment.directory);
        const [receipt] = readNodeScenarioFacts(environment.directory).fileReceipts;
        assert.ok(receipt);
        assert.deepEqual(
          {
            operationId: receipt.operationId,
            agentId: receipt.agentId,
            requestHash: receipt.requestHash,
            state: receipt.state,
            revision: receipt.revision,
          },
          {
            operationId: boundary.operationId,
            agentId: agent.summary.id,
            requestHash: boundary.requestHash,
            state: "succeeded",
            revision: 2,
          },
        );
        assert.equal(readFileActions(environment.directory)[0]?.receipt.state, "executing");
        assert.equal(readFileSync(path, "utf8"), edited);
        return { boundary, receipt, version: readFileVersion(path) };
      });
      const boundaryVersion = readFileVersion(path);
      assert.notDeepEqual(boundaryVersion, originalVersion);
      const unknown = await provider.waitFor(agent.summary.id, "observeUnknownBeforeNewDecision");
      const [started] = readFileActions(environment.directory);
      assert.ok(started);
      environment.node.child.kill("SIGKILL");
      await waitForScenario(
        "killed receipt node exited",
        () => environment.node.exitStatus,
        (fact) => fact !== undefined,
        { signal },
      );
      assert.deepEqual(environment.node.exitStatus, { code: null, signal: "SIGKILL" });
      await driver.waitForRun({ ...work, runId: started.receipt.runId }, "failed", { signal });
      assert.deepEqual(await unknown.outcome, {
        kind: "cancelled",
        reason: "node killed before terminal file receipt could return",
      });
      await environment.restartNode();
      await driver.waitForRun(work, "completed", { signal });
      await provider.assertComplete();
      assert.equal(readFileSync(path, "utf8"), edited);
      assert.deepEqual(readFileVersion(path), boundaryVersion);
      assert.equal(readFileSync(continued, "utf8"), "reconciled edited file; work continued\n");
      const actions = readFileActions(environment.directory);
      assert.equal(actions.length, 2);
      assert.equal(
        actions.find((action) => action.receipt.operationId === started.receipt.operationId)
          ?.receipt.state,
        "succeeded",
      );
      const events = await driver.activity(agent.summary.id, work.afterActivity, signal);
      assert.ok(
        events.some(
          (event) =>
            event.kind === "receipt.corrected" && event.referenceId === started.receipt.operationId,
        ),
      );
      assertOneSessionAndCurrentRun(
        environment.directory,
        agent.summary.id,
        agent.summary.sessionId,
      );
      const nodeEvents = readFileNodeEvents(environment.processes);
      assert.equal(
        nodeEvents.requests.filter((event) => event.operationId === started.receipt.operationId)
          .length,
        1,
      );
      assert.equal(
        nodeEvents.executions.filter((event) => event.operationId === started.receipt.operationId)
          .length,
        1,
      );
    },
  });
}, 30_000);
