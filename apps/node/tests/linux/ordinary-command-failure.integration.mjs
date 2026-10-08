// Real ordinary-command failure checks: a command that outlives its time bound, a node process that
// dies while a command is running, and the node coming back on the same durable receipts.
//
// Every step uses the real workspace provisioning, the real shell child process and the real node
// receipt database of the account running this check. The crash step runs a real second node process
// that hard-exits mid-command, so "was the start record already durable before the command ran?" is
// answered by the file system, not by a clean close inside this process. No root, no container and no
// service manager are involved.
//
// A macOS run is cross-platform evidence only; record real Linux results separately.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { prepareAgentWorkspace } from "@mate/node/agent-provisioner";
import { createLinuxAgentProcessExecutor } from "@mate/node/linux-process-executor";
import { AgentProcessOperations } from "@mate/node/process-operations";
import { openNodeProcessDatabase } from "@mate/node/database";

const launchingUid = typeof process.getuid === "function" ? process.getuid() : undefined;
if (launchingUid === 0)
  throw new Error("Run this check as the ordinary launching account, not as root.");
if (launchingUid === undefined)
  throw new Error("This check needs an account-aware host (Linux or macOS).");

const root = mkdtempSync(join(tmpdir(), "mate-command-failure-"));
const dataDirectory = join(root, "node-data");
const databasePath = join(dataDirectory, "agent-process-operations.sqlite");
const workspaceRoot = join(root, "agents");
const evidence = {
  check: "ordinary-command-failure-recovery",
  kernel: process.platform,
  linuxKernel: process.platform === "linux",
  containerized: existsSync("/.dockerenv"),
  launchingUid,
  launchingAccount: userInfo().username,
  ranAsRoot: false,
  timeout: {},
  disconnect: {},
  restart: {},
};

mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** The node's own process plumbing over the real receipt database, counting real command runs. */
function openNode(commandTimeoutMs) {
  const database = openNodeProcessDatabase(databasePath);
  const host = createLinuxAgentProcessExecutor(workspaceRoot, { commandTimeoutMs });
  const counts = new Map();
  return {
    operations: new AgentProcessOperations(database, (request) => {
      counts.set(request.operationId, (counts.get(request.operationId) ?? 0) + 1);
      return host(request);
    }),
    executionsOf: (operationId) => counts.get(operationId) ?? 0,
    close: () => database.close(),
  };
}

/** Start a real node process that runs one command and hard-exits before its result settles. */
function startCrashingNode(agentId, operationId, command, commandTimeoutMs, ledger) {
  const storageEntry = import.meta.resolve("@mate/node/database");
  const executorEntry = import.meta.resolve("@mate/node/linux-process-executor");
  const operationsEntry = import.meta.resolve("@mate/node/process-operations");
  const script = `
      const { openNodeProcessDatabase } = await import(${JSON.stringify(storageEntry)});
      const { createLinuxAgentProcessExecutor } = await import(${JSON.stringify(executorEntry)});
      const { AgentProcessOperations } = await import(${JSON.stringify(operationsEntry)});
      const database = openNodeProcessDatabase(process.env.MATE_FAILURE_DATABASE);
      const operations = new AgentProcessOperations(
        database,
        createLinuxAgentProcessExecutor(process.env.MATE_FAILURE_WORKSPACE_ROOT, {
          commandTimeoutMs: Number(process.env.MATE_FAILURE_COMMAND_TIMEOUT_MS),
        }),
      );
      void operations
        .execute(process.env.MATE_FAILURE_AGENT, process.env.MATE_FAILURE_OPERATION, {
          kind: "exec",
          command: process.env.MATE_FAILURE_COMMAND,
          cwd: ".",
        })
        .catch(() => undefined);
      // Wait until the command's own side effect has really happened, then die at once: this is the
      // node process disappearing mid-command, not a node that got to answer.
      const { existsSync } = await import("node:fs");
      const deadline = Date.now() + 10_000;
      while (!existsSync(process.env.MATE_FAILURE_LEDGER) && Date.now() < deadline)
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      process.stdout.write("NODE_SAW_COMMAND");
      // No close, no receipt, no cleanup: only what already reached the durable database survives.
      process.exit(0);
    `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      MATE_FAILURE_DATABASE: databasePath,
      MATE_FAILURE_WORKSPACE_ROOT: workspaceRoot,
      MATE_FAILURE_COMMAND_TIMEOUT_MS: String(commandTimeoutMs),
      MATE_FAILURE_AGENT: agentId,
      MATE_FAILURE_OPERATION: operationId,
      MATE_FAILURE_COMMAND: command,
      MATE_FAILURE_LEDGER: ledger,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (text += chunk));
  child.stderr.on("data", (chunk) => (text += chunk));
  return {
    exited: new Promise((resolveExit) => child.once("exit", (code) => resolveExit({ code, text }))),
  };
}

/** One durable node-side receipt row, read from the same file the node writes. */
function storedRow(operationId) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return database
      .prepare("SELECT state,receipt,revision FROM agent_process_operations WHERE operation_id=?")
      .get(operationId);
  } finally {
    database.close();
  }
}

try {
  // ---------------------------------------------------------------------- timeout
  const timeoutAgent = randomUUID();
  const timeoutWorkspace = await prepareAgentWorkspace({ agentId: timeoutAgent, workspaceRoot });
  const marker = join(timeoutWorkspace.workspace, "marker.txt");
  {
    const node = openNode(600);
    try {
      const operationId = randomUUID();
      const receipt = await node.operations.execute(timeoutAgent, operationId, {
        kind: "exec",
        command: `printf started >> ${JSON.stringify(marker)}; sleep 30`,
        cwd: ".",
      });
      assert.equal(receipt.state, "failed", "A command killed at its time bound is not a success");
      assert.equal(receipt.receipt.timedOut, true, "The receipt must name the timeout");
      assert.equal(
        readFileSync(marker, "utf8"),
        "started",
        "The command really ran before it timed out",
      );
      assert.equal(
        typeof receipt.receipt.processGroupRunning,
        "boolean",
        "The receipt says whether anything in the command's group survived",
      );
      evidence.timeout = {
        state: receipt.state,
        timedOut: receipt.receipt.timedOut,
        signal: receipt.receipt.signal,
        processGroupRunning: receipt.receipt.processGroupRunning,
        hostExecutionsForTimedOutCommand: node.executionsOf(operationId),
      };
    } finally {
      node.close();
    }
  }

  // ------------------------------------------------------------------- disconnect
  // A real node process dies mid-command. What the next node process finds is its durable start
  // record, never a claimed result.
  const interruptedAgent = randomUUID();
  const interruptedWorkspace = await prepareAgentWorkspace({
    agentId: interruptedAgent,
    workspaceRoot,
  });
  const ledger = join(interruptedWorkspace.workspace, "ledger.txt");
  const interruptedOperationId = randomUUID();
  // The tail is short on purpose: the process group this crash leaves behind is out of Mate's
  // reach, so the check lets it finish by itself instead of orphaning a long-lived process.
  const interruptedCommand = `printf 'executed\\n' >> ${JSON.stringify(ledger)}; sleep 5`;
  const crashing = startCrashingNode(
    interruptedAgent,
    interruptedOperationId,
    interruptedCommand,
    30_000,
    ledger,
  );
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !existsSync(ledger)) await delay(20);
  assert.equal(readFileSync(ledger, "utf8"), "executed\n", "The command really ran");
  const crashed = await crashing.exited;
  assert.equal(crashed.code, 0, `The crashing node did not exit as expected: ${crashed.text}`);
  // The shell is still alive under the dead node's own process group, and its start record reached
  // the database before the shell did — that ordering is what makes the row trustworthy.
  const startRow = storedRow(interruptedOperationId);
  assert.equal(
    startRow.state,
    "started",
    "A node that died mid-command leaves a durable start record, not a claimed result",
  );
  const sideEffectLinesBeforeRestart = readFileSync(ledger, "utf8").trimEnd().split("\n").length;

  // ---------------------------------------------------------------------- restart
  // A fresh node process opens the same databases. The start record is muted to unknown, and the
  // same operation ID replays that record instead of running the command a second time.
  const node = openNode(30_000);
  try {
    const replayed = await node.operations.execute(interruptedAgent, interruptedOperationId, {
      kind: "exec",
      command: interruptedCommand,
      cwd: ".",
    });
    assert.equal(replayed.state, "unknown", "The restarted node cannot prove the command's fate");
    assert.equal(
      replayed.receipt.reason,
      "node_restarted_during_operation",
      "The record must say why the result is unknown",
    );
    assert.equal(
      node.executionsOf(interruptedOperationId),
      0,
      "An already-started command must not be re-run after a restart",
    );
    assert.equal(readFileSync(ledger, "utf8"), "executed\n", "The side effect happened once");
    // A fresh durable action still runs: deduplication is per operation ID, not a stalled node.
    const freshMarker = join(interruptedWorkspace.workspace, "fresh.txt");
    const freshOperationId = randomUUID();
    const fresh = await node.operations.execute(interruptedAgent, freshOperationId, {
      kind: "exec",
      command: `printf fresh > ${JSON.stringify(freshMarker)}`,
      cwd: ".",
    });
    assert.equal(fresh.state, "succeeded", "A new command after the restart still runs");
    assert.equal(readFileSync(freshMarker, "utf8"), "fresh");
    evidence.disconnect = {
      durableStateWhileCommandRan: startRow.state,
      durableStartRowWrittenFirst: startRow.revision === 1,
      sideEffectLinesWhileCommandRan: sideEffectLinesBeforeRestart,
    };
    evidence.restart = {
      replayState: replayed.state,
      replayReason: replayed.receipt.reason,
      commandRunsAfterRestart: node.executionsOf(interruptedOperationId),
      sideEffectLinesAfterReplay: readFileSync(ledger, "utf8").trimEnd().split("\n").length,
      mutedRowState: storedRow(interruptedOperationId).state,
      freshCommandAfterRestart: fresh.state,
    };
  } finally {
    node.close();
  }

  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
