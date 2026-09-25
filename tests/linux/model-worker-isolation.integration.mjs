import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureModelWorkerIdentity } from "../../dist/src/nodes/model-identity.js";
import { startModelProcess } from "../../dist/src/nodes/model-process.js";
import {
  linuxUsernameForAgentId,
  provisionLinuxAgent,
} from "../../dist/src/nodes/agent-provisioner.js";

if (process.platform !== "linux" || process.geteuid?.() !== 0 || !existsSync("/.dockerenv"))
  throw new Error(
    "Run model worker isolation validation as root inside a disposable Linux container.",
  );
if (process.env.MATE_MODEL_TEST_SANDBOX !== "temporary-container")
  throw new Error("Refusing model worker validation outside its explicitly disposable container.");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function delay(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function childPids() {
  const text = readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8").trim();
  return text ? text.split(/\s+/).map(Number) : [];
}

function waitForWorkerPid() {
  const deadline = Date.now() + 5000;
  return (async () => {
    while (Date.now() < deadline) {
      const pid = childPids()[0];
      if (pid && existsSync(`/proc/${pid}/status`)) return pid;
      await delay(10);
    }
    throw new Error("Model worker process did not appear");
  })();
}

async function waitForWorkerExit(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!existsSync(`/proc/${pid}`)) return;
    await delay(10);
  }
  throw new Error("Canceled model worker remained alive");
}

function filesContain(path, token) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory() && filesContain(child, token)) return true;
    if (entry.isFile() && readFileSync(child).includes(token)) return true;
  }
  return false;
}

const homeRoot = `/var/lib/mate-model-worker-validation-${randomUUID()}`,
  agentId = randomUUID(),
  secret = randomBytes(32).toString("base64url"),
  workerIdentity = ensureModelWorkerIdentity();
mkdirSync(homeRoot, { mode: 0o700 });
const agent = await provisionLinuxAgent({ agentId, homeRoot }),
  ackSeen = deferred(),
  ackGate = deferred(),
  controller = new AbortController();
const worker = startModelProcess({
  provider: "openai",
  modelId: "gpt-4o-mini",
  apiKey: secret,
  entry: resolve("tests/fixtures/direct-message-model-worker.mjs"),
  identity: workerIdentity,
  onJournal: async () => {
    ackSeen.resolve();
    return ackGate.promise;
  },
  signal: controller.signal,
});

let run;
try {
  run = worker.run({
    runId: randomUUID(),
    sessionId: randomUUID(),
    messages: [{ sequence: 1, role: "user", text: "Synthetic owner DM process check." }],
    prompt: { name: "Synthetic Agent", role: "Validation", description: "No private data." },
  });
  await Promise.race([
    ackSeen.promise,
    delay(5000).then(() => {
      throw new Error("Model worker did not reach its journal gate");
    }),
  ]);
  const pid = await waitForWorkerPid(),
    status = readFileSync(`/proc/${pid}/status`, "utf8"),
    uidLine = status.split("\n").find((line) => line.startsWith("Uid:")),
    gidLine = status.split("\n").find((line) => line.startsWith("Gid:")),
    groupsLine = status.split("\n").find((line) => line.startsWith("Groups:")),
    environ = readFileSync(`/proc/${pid}/environ`);
  assert.ok(uidLine && Number(uidLine.split(/\s+/)[2]) === workerIdentity.uid);
  assert.ok(gidLine && Number(gidLine.split(/\s+/)[2]) === workerIdentity.gid);
  assert.ok(groupsLine && groupsLine.trim() === "Groups:");
  assert.notEqual(workerIdentity.uid, agent.uid);
  assert.equal(environ.includes(Buffer.from(secret)), true);
  const agentRead = spawnSync(
    "/usr/bin/setpriv",
    [
      `--reuid=${agent.uid}`,
      `--regid=${agent.gid}`,
      "--clear-groups",
      "--",
      "/usr/bin/cat",
      `/proc/${pid}/environ`,
    ],
    { encoding: "buffer" },
  );
  assert.notEqual(agentRead.status, 0);
  assert.equal(agentRead.stdout.includes(Buffer.from(secret)), false);
  assert.equal(filesContain(agent.home, Buffer.from(secret)), false);
  assert.equal(process.env.MATE_MODEL_KEY, undefined);

  ackGate.resolve(true);
  await run;
  await delay(30);
  assert.equal(existsSync(`/proc/${pid}`), false);

  // A credential-change cancel uses the same AbortSignal path as a real Node run.
  const canceledController = new AbortController(),
    canceledWorker = startModelProcess({
      provider: "openai",
      modelId: "gpt-4o-mini",
      apiKey: "synthetic-key-held-only-until-cancel",
      entry: resolve("tests/fixtures/direct-message-model-worker.mjs"),
      identity: workerIdentity,
      onJournal: async () => false,
      signal: canceledController.signal,
    });
  const canceledRun = canceledWorker.run({
    runId: randomUUID(),
    sessionId: randomUUID(),
    messages: [{ sequence: 1, role: "user", text: "Synthetic cancellation process check." }],
    prompt: { name: "Synthetic Agent", role: "Validation", description: "No private data." },
  });
  const canceledPid = await waitForWorkerPid();
  assert.equal(
    readFileSync(`/proc/${canceledPid}/environ`).includes(
      Buffer.from("synthetic-key-held-only-until-cancel"),
    ),
    true,
  );
  canceledController.abort();
  await assert.rejects(canceledRun);
  await waitForWorkerExit(canceledPid);
  assert.equal(process.env.MATE_MODEL_KEY, undefined);
  assert.equal(
    filesContain(agent.home, Buffer.from("synthetic-key-held-only-until-cancel")),
    false,
  );
  process.stdout.write(
    `${JSON.stringify({
      mode: "real-linux-container",
      kernel: process.platform,
      nodeServiceUid: process.getuid(),
      workerAccount: "mate-model",
      workerUid: workerIdentity.uid,
      workerGid: workerIdentity.gid,
      workerHasNoSupplementaryGroups: true,
      agentAccount: linuxUsernameForAgentId(agentId),
      agentUid: agent.uid,
      agentGid: agent.gid,
      agentCannotReadWorkerEnvironment: true,
      keyOnlyInLiveWorkerEnvironment: true,
      shortLivedWorkerExited: true,
      credentialChangeCancelExitedWorker: true,
      canceledWorkerEnvironmentReleased: true,
      homeAndNodeParentContainNoKey: true,
    })}\n`,
  );
} finally {
  ackGate.resolve(false);
  controller.abort();
  worker.close();
  rmSync(homeRoot, { recursive: true, force: true });
}
