import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { z } from "zod";
import { runScenario } from "../../support/scenario/scenario-evidence.js";
import { createScriptedProvider } from "../../support/agent/scripted-provider.js";
import {
  fileModelCorrections,
  readFileActions,
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
          const initial = provider.requests.find(
            (request) =>
              request.step === "observeUnknownBeforeNewDecision" &&
              request.agentId === agent.summary.id,
          );
          assert.ok(
            initial,
            "Expected the actual pre-crash request with the persisted edit and unknown result",
          );
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
        function acknowledgeReceiptNotification(request) {
          const corrections = fileModelCorrections(request.payload.input).filter(
            (fact) =>
              fact.operationId === readFileBoundary(environment.directory).operationId &&
              fact.state === "succeeded",
          );
          assert.equal(
            corrections.length,
            1,
            "The appended receipt fact is not repeated by its notification",
          );
          request.text("更正通知已处理。");
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
      // waitFor observes arrival before the provider step runs; arm its cancellation first.
      await unknown.finished;
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
      // The receipt notification is a separate delivery; completing the recovered work
      // does not imply that its later notification has reached the model yet.
      const notification = await provider.waitFor(
        agent.summary.id,
        "acknowledgeReceiptNotification",
      );
      await notification.finished;
      assert.deepEqual(await notification.outcome, { kind: "responded" });
      const receiptMessage = (await driver.messages(agent.channelId, signal)).find((message) =>
        message.text.startsWith(`Mate 已核对操作 ${started.receipt.operationId}`),
      );
      assert.ok(receiptMessage);
      await driver.waitForRun({ ...work, message: receiptMessage }, "completed", { signal });
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

it("a faster peer file mutation cannot report the held Agent's receipt boundary", async () => {
  const provider = createScriptedProvider({ timeoutMs: 15_000 });
  await runScenario({
    name: "file-concurrent-receipt-identity",
    provider,
    environment: {
      agents: [{ name: "暂留文件执行的同事" }, { name: "先完成文件的同事" }],
      node: { fileBoundary: "before_receipt", holdFirstFileExecution: true },
    },
    async run({ environment, driver, signal, step, effectFile }) {
      const [held, peer] = environment.agents;
      assert.ok(held && peer);
      const heldFile = join(held.workspace, "held.txt");
      const peerFile = join(peer.workspace, "peer.txt");
      effectFile("held.txt", heldFile);
      effectFile("peer.txt", peerFile);
      provider.forAgent(held, [
        function writeHeldFile(request) {
          request.call("workspace.write", { path: "held.txt", content: "held Agent completed\n" });
        },
        function finishHeld(request) {
          assert.equal(
            request.result("workspace.write", z.object({ sha256: z.string() })).sha256,
            createHash("sha256").update("held Agent completed\n").digest("hex"),
          );
          request.text("暂留同事已完成。");
        },
      ]);
      provider.forAgent(peer, [
        function writePeerFile(request) {
          request.call("workspace.write", { path: "peer.txt", content: "peer completed first\n" });
        },
        function finishPeer(request) {
          assert.equal(
            request.result("workspace.write", z.object({ sha256: z.string() })).sha256,
            createHash("sha256").update("peer completed first\n").digest("hex"),
          );
          request.text("同伴先完成。");
        },
      ]);
      const heldWork = await driver.sendOwnerMessage(held, "写入自己的合成文件。");
      await step("first Agent has durable start and is held before real execution", async () => {
        await environment.node.waitFor(/MATE_SCENARIO_FILE_EXECUTION_HELD /, 5000, { signal });
        const actions = readFileActions(environment.directory);
        assert.equal(actions.length, 1);
        assert.equal(actions[0]?.agentId, held.summary.id);
        assert.equal(actions[0]?.receipt.state, "executing");
        assert.equal(existsSync(heldFile), false);
        return actions;
      });
      const peerWork = await driver.sendOwnerMessage(peer, "写入自己的另一份合成文件。");
      await step(
        "peer's actual file and terminal receipt complete while first Agent stays held",
        async () => {
          const run = await driver.waitForRun(peerWork, "completed", { signal });
          assert.equal(readFileSync(peerFile, "utf8"), "peer completed first\n");
          assert.equal(existsSync(heldFile), false);
          assert.equal(
            existsSync(join(environment.directory, "node-data", "file-boundary-reached.json")),
            false,
          );
          const peerAction = readFileActions(environment.directory).find(
            (action) => action.agentId === peer.summary.id,
          );
          assert.equal(peerAction?.receipt.state, "succeeded");
          return { run, peerAction };
        },
      );
      writeFileSync(join(environment.directory, "node-data", "file-execution-release"), "release", {
        mode: 0o600,
      });
      await step("only held Agent's real mutation reports its own receipt boundary", async () => {
        await environment.node.waitFor(/MATE_SCENARIO_FILE_BOUNDARY /, 5000, { signal });
        const boundary = readFileBoundary(environment.directory);
        assert.equal(boundary.agentId, held.summary.id);
        assert.equal(readFileSync(heldFile, "utf8"), "held Agent completed\n");
        const receipt = readNodeScenarioFacts(environment.directory).fileReceipts.find(
          (receipt) => receipt.operationId === boundary.operationId,
        );
        assert.equal(receipt?.state, "executing");
        const action = readFileActions(environment.directory).find(
          (action) => action.receipt.operationId === boundary.operationId,
        );
        assert.equal(action?.agentId, held.summary.id);
        assert.equal(action?.receipt.state, "executing");
        return { boundary, receipt, action };
      });
      writeFileSync(join(environment.directory, "node-data", "file-boundary-release"), "release", {
        mode: 0o600,
      });
      await driver.waitForRun(heldWork, "completed", { signal });
      await provider.assertComplete();
      assertOneSessionAndCurrentRun(environment.directory, held.summary.id, held.summary.sessionId);
      assertOneSessionAndCurrentRun(environment.directory, peer.summary.id, peer.summary.sessionId);
      assert.notEqual(held.summary.sessionId, peer.summary.sessionId);
    },
  });
}, 30_000);
