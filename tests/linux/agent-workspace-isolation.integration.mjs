import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { LinuxWorkspaceExecutor } from "../../dist/src/nodes/workspace-execution.js";
import { provisionLinuxAgent } from "../../dist/src/nodes/agent-provisioner.js";

if (process.platform !== "linux" || process.geteuid?.() !== 0 || !existsSync("/.dockerenv"))
  throw new Error("Run workspace isolation checks as root inside a disposable Linux container.");
if (process.env.MATE_AGENT_TEST_SANDBOX !== "temporary-container")
  throw new Error(
    "Refusing workspace isolation checks outside an explicitly disposable container.",
  );
for (const path of ["/usr/bin/setpriv", "/usr/sbin/useradd", "/usr/bin/getent"])
  if (!existsSync(path)) throw new Error(`Required Linux executable is missing: ${path}`);

const homeRoot = `/var/lib/mate-workspace-validation-${randomUUID()}`,
  nodeData = `${homeRoot}-node-data`,
  outside = `/tmp/mate-workspace-outside-${randomUUID()}`,
  agentAId = randomUUID(),
  agentBId = randomUUID(),
  helper = resolve("dist/src/execution/file-operation.mjs"),
  agents = [];

function runAs(identity, operation) {
  const result = spawnSync(
    "/usr/bin/setpriv",
    [
      `--reuid=${identity.uid}`,
      `--regid=${identity.gid}`,
      "--clear-groups",
      "--no-new-privs",
      "--",
      process.execPath,
      helper,
      identity.home,
      "077",
    ],
    {
      input: JSON.stringify(operation),
      encoding: "utf8",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
    },
  );
  if (result.error) throw result.error;
  return {
    code: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: false,
  };
}

function executorFor(agentId) {
  return new LinuxWorkspaceExecutor(homeRoot, nodeData, {
    createBackend: (_id, identity) => ({
      execute: async ({ operation }) => runAs(identity, operation),
    }),
  });
}

function successful(result) {
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

try {
  mkdirSync(homeRoot, { mode: 0o755 });
  chmodSync(homeRoot, 0o755);
  mkdirSync(nodeData, { mode: 0o700 });
  chmodSync(nodeData, 0o700);
  mkdirSync(outside, { mode: 0o700 });
  const [agentA, agentB] = await Promise.all([
    provisionLinuxAgent({ agentId: agentAId, homeRoot }),
    provisionLinuxAgent({ agentId: agentBId, homeRoot }),
  ]);
  agents.push(agentA, agentB);
  assert.notEqual(agentA.uid, agentB.uid);
  assert.notEqual(agentA.gid, agentB.gid);

  const executorA = executorFor(agentAId),
    executorB = executorFor(agentBId),
    writeRequest = {
      operationId: randomUUID(),
      agentId: agentAId,
      mode: "agent_action",
      operation: { kind: "write", path: "notes/deep/summary.txt", content: "private note" },
    };
  const writeReceipt = await executorA.execute(writeRequest);
  assert.equal(writeReceipt.code, 0, writeReceipt.stderr);
  const replay = await executorA.execute(writeRequest);
  assert.deepEqual(replay, writeReceipt);
  assert.equal(statSync(join(agentA.home, "notes/deep/summary.txt")).uid, agentA.uid);
  assert.equal(statSync(join(agentA.home, "notes/deep/summary.txt")).gid, agentA.gid);
  assert.equal(statSync(join(agentA.home, "notes/deep/summary.txt")).mode & 0o777, 0o600);

  for (const [path, content] of [
    ["move-source.txt", "source remains intact"],
    ["move-target.txt", "target must not be replaced"],
  ])
    successful(
      await executorA.execute({
        operationId: randomUUID(),
        agentId: agentAId,
        mode: "agent_action",
        operation: { kind: "write", path, content },
      }),
    );
  const rejectedMove = await executorA.execute({
    operationId: randomUUID(),
    agentId: agentAId,
    mode: "agent_action",
    operation: { kind: "move", path: "move-source.txt", destination: "move-target.txt" },
  });
  assert.notEqual(rejectedMove.code, 0);
  assert.match(rejectedMove.stderr, /destination_exists/);
  assert.equal(readFileSync(join(agentA.home, "move-source.txt"), "utf8"), "source remains intact");
  assert.equal(
    readFileSync(join(agentA.home, "move-target.txt"), "utf8"),
    "target must not be replaced",
  );
  assert.equal(statSync(join(agentA.home, "move-source.txt")).nlink, 1);
  assert.equal(statSync(join(agentA.home, "move-target.txt")).nlink, 1);

  successful(
    await executorA.execute({
      operationId: randomUUID(),
      agentId: agentAId,
      mode: "agent_action",
      operation: { kind: "move", path: "move-source.txt", destination: "moved.txt" },
    }),
  );
  assert.equal(existsSync(join(agentA.home, "move-source.txt")), false);
  assert.equal(readFileSync(join(agentA.home, "moved.txt"), "utf8"), "source remains intact");
  assert.equal(statSync(join(agentA.home, "moved.txt")).nlink, 1);

  const stat = JSON.parse(
      successful(
        await executorA.execute({
          operationId: randomUUID(),
          agentId: agentAId,
          mode: "owner_read",
          operation: { kind: "workspace_stat", path: "notes/deep/summary.txt" },
        }),
      ),
    ),
    chunk = JSON.parse(
      successful(
        await executorA.execute({
          operationId: randomUUID(),
          agentId: agentAId,
          mode: "owner_read",
          operation: {
            kind: "workspace_read_chunk",
            path: "notes/deep/summary.txt",
            offset: 0,
            length: 8192,
            version: stat.version,
          },
        }),
      ),
    );
  assert.equal(Buffer.from(chunk.base64, "base64").toString(), "private note");

  const secret = join(agentA.home, "private.txt");
  successful(
    await executorA.execute({
      operationId: randomUUID(),
      agentId: agentAId,
      mode: "agent_action",
      operation: { kind: "write", path: "private.txt", content: "only Agent A can read this\n" },
    }),
  );
  const peerRead = spawnSync(
    "/usr/bin/setpriv",
    [
      `--reuid=${agentB.uid}`,
      `--regid=${agentB.gid}`,
      "--clear-groups",
      "--",
      "/usr/bin/cat",
      secret,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(peerRead.status, 0, "a different Agent Linux user must not read this home");

  const escaped = await executorB.execute({
    operationId: randomUUID(),
    agentId: agentBId,
    mode: "owner_read",
    operation: { kind: "workspace_stat", path: `../${agentAId}/private.txt` },
  });
  assert.notEqual(escaped.code, 0, "relative traversal must not leave Agent B's home");

  const outsideFile = join(outside, "secret.txt");
  writeFileSync(outsideFile, "outside workspace", { mode: 0o644 });
  chmodSync(outsideFile, 0o644);
  symlinkSync(outsideFile, join(agentA.home, "outside-link"));
  const symlinkRead = await executorA.execute({
    operationId: randomUUID(),
    agentId: agentAId,
    mode: "owner_read",
    operation: { kind: "workspace_read_chunk", path: "outside-link", offset: 0, length: 8192 },
  });
  assert.notEqual(symlinkRead.code, 0, "file operations must not follow a workspace symlink");

  assert.throws(() =>
    executorA.execute({
      operationId: randomUUID(),
      agentId: agentAId,
      mode: "owner_read",
      operation: { kind: "write", path: "forbidden.txt", content: "no" },
    }),
  );

  const raceRoot = join(agentA.home, "race"),
    outsideRace = join(outside, "race-target");
  mkdirSync(join(raceRoot, "subdir"), { recursive: true, mode: 0o700 });
  mkdirSync(join(outsideRace, "subdir"), { recursive: true, mode: 0o700 });
  for (const directory of [
    raceRoot,
    join(raceRoot, "subdir"),
    outsideRace,
    join(outsideRace, "subdir"),
  ]) {
    chownSync(directory, agentA.uid, agentA.gid);
    chmodSync(directory, 0o700);
  }
  const raceScript = `
    const fs = require('node:fs');
    const root = process.argv[1], target = process.argv[2], saved = root + '.saved';
    for (;;) {
      try { fs.renameSync(root, saved); } catch {}
      try { fs.symlinkSync(target, root); } catch {}
      try { fs.unlinkSync(root); } catch {}
      try { fs.renameSync(saved, root); } catch {}
    }
  `;
  const toggler = spawn(
    "/usr/bin/setpriv",
    [
      `--reuid=${agentA.uid}`,
      `--regid=${agentA.gid}`,
      "--clear-groups",
      "--",
      process.execPath,
      "-e",
      raceScript,
      raceRoot,
      outsideRace,
    ],
    { stdio: "ignore" },
  );
  try {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    for (let index = 0; index < 80; index++) {
      await executorA.execute({
        operationId: randomUUID(),
        agentId: agentAId,
        mode: "agent_action",
        operation: {
          kind: "write",
          path: `race/subdir/race-${index}.txt`,
          content: "must stay inside the home",
        },
      });
    }
  } finally {
    toggler.kill("SIGKILL");
    await new Promise((resolvePromise) => toggler.once("exit", resolvePromise));
  }
  assert.deepEqual(
    (await import("node:fs")).readdirSync(join(outsideRace, "subdir")),
    [],
    "racing a workspace directory with a symlink must not write outside the home",
  );

  const receiptDirectory = join(nodeData, "workspace-receipts"),
    storedReceipt = JSON.parse(
      readFileSync(join(receiptDirectory, `${writeRequest.operationId}.json`), "utf8"),
    );
  assert.equal(storedReceipt.state, "succeeded");
  process.stdout.write(
    `${JSON.stringify({
      mode: "real-linux-container",
      kernel: process.platform,
      agentUids: [agentA.uid, agentB.uid],
      stableActionReceipt: storedReceipt.state,
      privateMode: `0${(statSync(join(agentA.home, "notes/deep/summary.txt")).mode & 0o777).toString(8)}`,
      separateAgentReadDenied: peerRead.status !== 0,
      relativeTraversalDenied: escaped.code !== 0,
      symlinkReadDenied: symlinkRead.code !== 0,
      symlinkRaceWritesOutside: 0,
    })}\n`,
  );
} finally {
  for (const agent of agents) {
    const removal = spawnSync("/usr/sbin/userdel", ["--remove", agent.username], {
      encoding: "utf8",
    });
    if (removal.error || removal.status !== 0)
      process.stderr.write(
        `Could not remove temporary account ${agent.username}: ${removal.stderr}\n`,
      );
  }
  rmSync(homeRoot, { recursive: true, force: true });
  rmSync(nodeData, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
