import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { z } from "zod";
import { runScenario } from "../../support/scenario/scenario-evidence.js";
import { createScriptedProvider } from "../../support/agent/scripted-provider.js";
import {
  fileModelCorrections,
  fileBoundarySchema,
  readFileActions,
  readCommittedFileCalls,
  readFileBoundary,
  readFileNodeEvents,
  readFileVersion,
} from "../../support/facts/scenario-file-facts.js";
import { readNodeScenarioFacts } from "../../support/facts/scenario-facts.js";
import { waitForScenario } from "../../support/scenario/scenario-driver.js";
import {
  original,
  edited,
  assertOneSessionAndCurrentRun,
} from "../../support/scenario/file-boundary-test-fixture.js";

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
          async function inspectUnknown(request) {
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
            const [action] = readFileActions(environment.directory);
            assert.ok(action);
            const calls = await readCommittedFileCalls(environment.directory, agent.summary.id);
            assert.equal(calls.length, 1);
            const [committed] = calls;
            assert.ok(committed);
            const recovered = z
              .object({
                type: z.literal("function_call"),
                call_id: z.string(),
                id: z.string(),
                name: z.string(),
                arguments: z.string(),
              })
              .array()
              .parse(
                request.payload.input.filter(
                  (item) => z.object({ type: z.literal("function_call") }).safeParse(item).success,
                ),
              );
            const [call] = recovered;
            assert.ok(call);
            assert.equal(committed.id, `${call.call_id}|${call.id}`);
            assert.equal(committed.name, call.name);
            assert.deepEqual(committed.arguments, JSON.parse(call.arguments));
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
