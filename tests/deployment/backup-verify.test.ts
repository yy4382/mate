import Database from "better-sqlite3";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initializeCoordinatedRoots } from "../helpers/coordinated-state.js";
import {
  createCoordinatedCheckpoint,
  RECOVERY_MARKER,
  verifyCoordinatedCheckpoint,
} from "../../src/deployment/coordinated-checkpoint.js";
import { AgentProcessOperations } from "../../src/nodes/process-operations.js";
import { OwnerChat } from "../../src/control-plane/owner-chat.js";
import { deploymentMain, type DeploymentServices } from "../../src/deployment/cli.js";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const agentId = "11111111-1111-4111-8111-111111111111";

/** A literal path, usable inside a regular expression that is about that path. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One ordinary-account deployment's persistent state, built from the real stores. */
function deployment() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-backup-verify-")));
  roots.push(root);
  const controlPlaneDataDir = join(root, "control"),
    nodeDataDir = join(root, "node"),
    agentHomeRoot = join(root, "homes"),
    checkpoint = join(root, "checkpoint");
  initializeCoordinatedRoots({ controlPlaneDataDir, nodeDataDir, agentHomeRoot });
  return {
    root,
    checkpoint,
    paths: { controlPlaneDataDir, nodeDataDir, agentHomeRoot },
    /** The Agent workspace a completed backup has to carry. */
    workspace: join(agentHomeRoot, agentId),
    /** The deployment configuration the owner's own commands are run with. */
    configPath: (() => {
      const path = join(root, "deploy.json");
      writeFileSync(
        path,
        `${JSON.stringify(
          {
            version: 1,
            publicOrigin: "https://mate.example.test",
            controlPlanePort: 4599,
            releaseRoot: join(root, "app"),
            stateDir: join(root, "state"),
            controlPlaneDataDir,
            nodeDataDir,
            agentHomeRoot,
            ownerPasswordFile: join(root, "owner-password"),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      return path;
    })(),
  };
}

/** Record the state an owner really has: a channel, its message, the task on it and a receipt. */
async function populate(d: ReturnType<typeof deployment>) {
  const control = new Database(join(d.paths.controlPlaneDataDir, "control-plane.sqlite")),
    chat = new OwnerChat(control);
  const channel = chat.createChannel({
    name: "部署检查",
    description: "备份检查用的频道",
    visibility: "public",
  });
  const message = chat.createMessage(channel.id, "把这条消息一起备份下来。");
  if (!message) throw new Error("the message was not created");
  const task = chat.createTaskForMessage(message.id, "human", "owner");
  control.close();
  const nodeStore = new Database(join(d.paths.nodeDataDir, "agent-process-operations.sqlite")),
    operations = new AgentProcessOperations(nodeStore, async () => ({
      state: "succeeded",
      receipt: { processes: [] },
    })),
    receipt = await operations.execute(agentId, randomUUID(), { kind: "process.list" });
  nodeStore.close();
  mkdirSync(d.workspace, { mode: 0o700 });
  writeFileSync(join(d.workspace, "MEMORY.md"), "private memory", { mode: 0o600 });
  return { messageId: message.id, taskId: task.id, operationId: receipt.operationId };
}

function serviceStub(stopped: Record<string, unknown>): DeploymentServices {
  return {
    start: async () => ({ reports: {} }),
    stop: async () => ({ reports: stopped }),
    restart: async () => ({ reports: {} }),
    reports: () => ({ node: { state: "running", pid: 7 } }),
  };
}

async function backup(
  args: string[],
  services?: DeploymentServices,
  installRelease?: (config: never, release: string) => string,
): Promise<{ report: Record<string, unknown>; output: string }> {
  const output: string[] = [];
  await deploymentMain(args, {
    write: (text) => output.push(text),
    ...(services ? { services: () => services } : {}),
    ...(installRelease ? { installRelease: installRelease as never } : {}),
  });
  return {
    report: JSON.parse(output.join("")) as Record<string, unknown>,
    output: output.join(""),
  };
}

it("refuses to publish a backup whose control-plane database is not Mate's own state", async () => {
  const d = deployment();
  // A fresh, valid, empty database where the control plane's own one belongs: integrity holds, the
  // state does not. Nothing may be published as a backup of it.
  rmSync(join(d.paths.controlPlaneDataDir, "control-plane.sqlite"));
  const empty = new Database(join(d.paths.controlPlaneDataDir, "control-plane.sqlite"));
  empty.close();
  await expect(createCoordinatedCheckpoint(d.paths, d.checkpoint, async () => {})).rejects.toThrow(
    /missing required .*state/i,
  );
  // This is found on the deployment's own state before anything is created for the copy, so there
  // is not even a partial directory to mistake for a backup.
  expect(existsSync(d.checkpoint)).toBe(false);
});

it("stops at a path it cannot read instead of publishing a partial backup", async () => {
  const d = deployment();
  const workspace = d.workspace;
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(join(workspace, "MEMORY.md"), "private memory", { mode: 0o600 });
  chmodSync(workspace, 0o000);
  try {
    // The failure has to name the path the account could not read and say plainly that what is
    // left is not a backup, because that is the whole result the owner gets.
    await expect(
      createCoordinatedCheckpoint(d.paths, d.checkpoint, async () => {}),
    ).rejects.toThrow(
      new RegExp(
        `not a backup[\\s\\S]*${escapeForRegExp(workspace)}|${escapeForRegExp(workspace)}[\\s\\S]*not a backup`,
      ),
    );
  } finally {
    chmodSync(workspace, 0o700);
  }
  // The refusal is the whole result: the destination has no completion marker, and a verification
  // of what is left refuses it rather than reading a half-copied tree as a backup.
  expect(existsSync(join(d.checkpoint, "complete.json"))).toBe(false);
  expect(() => verifyCoordinatedCheckpoint(d.checkpoint)).toThrow(/incomplete/i);
});

it("refuses to copy state an unfinished restore left unreconciled", async () => {
  const d = deployment();
  writeFileSync(`${d.paths.controlPlaneDataDir}.${RECOVERY_MARKER}`, "unfinished restore", {
    mode: 0o600,
  });
  await expect(createCoordinatedCheckpoint(d.paths, d.checkpoint, async () => {})).rejects.toThrow(
    /recovery|incomplete/i,
  );
  // The refusal happens before anything is created, so there is not even a partial directory to
  // mistake for a backup.
  expect(existsSync(d.checkpoint)).toBe(false);
});

it("proves a checkpoint holds the Mate state it was taken for, not only valid SQLite files", async () => {
  const d = deployment();
  await createCoordinatedCheckpoint(d.paths, d.checkpoint, async () => {});
  expect(verifyCoordinatedCheckpoint(d.checkpoint).entries.length).toBeGreaterThan(5);
  // A valid but foreign database is what the integrity check alone cannot tell apart from Mate's
  // own: an empty SQLite file passes `PRAGMA integrity_check` with an "ok" result, so a checkpoint
  // built from one would verify while carrying none of the state it claims to hold.
  const databasePath = join(d.checkpoint, "control", "control-plane.sqlite");
  rmSync(databasePath);
  const empty = new Database(databasePath);
  empty.close();
  expect(() => verifyCoordinatedCheckpoint(d.checkpoint)).toThrow(/required .*state/i);
});

it("writes the documented default checkpoint into the owner's own state directory", async () => {
  const d = deployment();
  await populate(d);
  // `backup CONFIG` with no destination is the first form the operations document gives, so it has
  // to work on a deployment that has never run it before.
  const { report } = await backup(["backup", d.configPath]);
  const checkpoint = String(report.checkpoint);
  expect(checkpoint.startsWith(join(d.root, "state", "checkpoints") + "/")).toBe(true);
  expect(existsSync(join(checkpoint, "complete.json"))).toBe(true);
  expect(statSync(checkpoint).mode & 0o777).toBe(0o700);
  expect(statSync(join(d.root, "state", "checkpoints")).mode & 0o777).toBe(0o700);
  expect((await backup(["verify", d.configPath, checkpoint])).report.id).toBe(report.id);
});

it("writes an upgrade's recovery checkpoint into the same owner-owned place", async () => {
  const d = deployment();
  await populate(d);
  // An upgrade takes its recovery point through the same seam as a backup, so it must be able to
  // make one on a deployment that has never been backed up.
  const { report } = await backup(
    ["upgrade", d.configPath, join(d.root, "app")],
    serviceStub({}),
    (() => join(d.root, "app", "releases", "deadbeef")) as never,
  );
  expect(String(report.checkpointPath).startsWith(join(d.root, "state", "checkpoints") + "/")).toBe(
    true,
  );
  expect(existsSync(join(String(report.checkpointPath), "complete.json"))).toBe(true);
});

it("carries the owner's messages, tasks, receipts and Agent workspaces into a backup it verifies", async () => {
  const d = deployment();
  const state = await populate(d);
  const { report } = await backup(["backup", d.configPath, d.checkpoint]);
  expect(report).toMatchObject({ checkpoint: d.checkpoint });
  expect(typeof report.id).toBe("string");
  expect(report.entries).toBeGreaterThan(5);
  // The checkpoint is private to the account that made it, like the state it copies.
  expect(statSync(d.checkpoint).mode & 0o777).toBe(0o700);

  const control = new Database(join(d.checkpoint, "control", "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  expect(
    control.prepare("SELECT text FROM owner_messages WHERE id=?").get(state.messageId),
  ).toEqual({ text: "把这条消息一起备份下来。" });
  expect(control.prepare("SELECT status FROM owner_tasks WHERE id=?").get(state.taskId)).toEqual({
    status: "open",
  });
  // The stores this release keeps its session, message, task and reminder state in are all in the
  // copy and readable through it; that is what `verify` proves rather than only the file names.
  for (const table of [
    "owner_agent_sessions",
    "owner_agent_session_journal",
    "owner_sessions",
    "owner_message_deliveries",
    "owner_task_events",
    "owner_reminders",
    "owner_reminder_firings",
    "owner_agent_process_operations",
  ])
    expect(control.prepare(`SELECT count(*) AS rows FROM ${table}`).get()).toEqual({
      rows: expect.any(Number),
    });
  control.close();

  const receipts = new Database(join(d.checkpoint, "node", "agent-process-operations.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  expect(
    receipts
      .prepare("SELECT state FROM agent_process_operations WHERE operation_id=?")
      .get(state.operationId),
  ).toEqual({ state: "succeeded" });
  receipts.close();

  expect(readFileSync(join(d.checkpoint, "homes", agentId, "MEMORY.md"), "utf8")).toBe(
    "private memory",
  );
  // And the documented `verify` command accepts exactly that checkpoint.
  const verified = await backup(["verify", d.configPath, d.checkpoint]);
  expect(verified.report.id).toBe(report.id);
  expect(verified.report.format).toBe(1);
});

it("refuses a checkpoint whose copied bytes no longer match what was written", async () => {
  const d = deployment();
  await populate(d);
  await backup(["backup", d.configPath, d.checkpoint]);
  writeFileSync(join(d.checkpoint, "homes", agentId, "MEMORY.md"), "tampered memory", {
    mode: 0o600,
  });
  await expect(backup(["verify", d.configPath, d.checkpoint])).rejects.toThrow(/integrity/i);
  // A verification that failed leaves the checkpoint exactly as it found it: nothing is repaired,
  // and the next verification refuses it for the same reason.
  expect(readFileSync(join(d.checkpoint, "homes", agentId, "MEMORY.md"), "utf8")).toBe(
    "tampered memory",
  );
  await expect(backup(["verify", d.configPath, d.checkpoint])).rejects.toThrow(/integrity/i);
});

it("leaves no backup when the node's own receipts still hold an unfinished command", async () => {
  const d = deployment();
  const state = await populate(d);
  // A command the node recorded as started and never settled: it was still running when the node
  // went away, its process group outlives the node, and no shutdown report can speak for it.
  const nodeStore = new Database(join(d.paths.nodeDataDir, "agent-process-operations.sqlite"));
  nodeStore
    .prepare("UPDATE agent_process_operations SET state='started' WHERE operation_id=?")
    .run(state.operationId);
  nodeStore.close();
  await expect(backup(["backup", d.configPath, d.checkpoint])).rejects.toThrow(/至少|未结束|命令/);
  expect(existsSync(d.checkpoint)).toBe(false);

  // A settled unknown is a result the owner reviews, not work still running: it must not make the
  // deployment impossible to back up.
  const settled = new Database(join(d.paths.nodeDataDir, "agent-process-operations.sqlite"));
  settled
    .prepare("UPDATE agent_process_operations SET state='unknown' WHERE operation_id=?")
    .run(state.operationId);
  settled.close();
  const { report } = await backup(["backup", d.configPath, d.checkpoint]);
  expect(typeof report.id).toBe("string");
});

it("refuses a second maintenance step that would copy state the first one resumed", async () => {
  const d = deployment();
  await populate(d);
  // The first backup is held inside its quiesce, which is exactly where a second one would see the
  // services as already stopped, copy state the first had resumed, and certify it.
  let releaseStop!: () => void;
  const stopped = new Promise<void>((resolveStopped) => {
    releaseStop = resolveStopped;
  });
  const slow: DeploymentServices = {
    ...serviceStub({}),
    stop: async () => {
      await stopped;
      return { reports: {} };
    },
  };
  const first = backup(["backup", d.configPath, join(d.root, "first")], slow);
  // A `start` is the other half of the same race — and the reflex an owner has when a backup looks
  // stuck — so it takes the same lock.
  await expect(backup(["start", d.configPath], serviceStub({}))).rejects.toThrow(/lock/i);
  await expect(backup(["backup", d.configPath, join(d.root, "second")])).rejects.toThrow(/lock/i);
  releaseStop();
  await first;
  expect(existsSync(join(d.root, "first", "complete.json"))).toBe(true);
  expect(existsSync(join(d.root, "second"))).toBe(false);
});

it("still lets the repair commands run when receipts hold an unfinished command", async () => {
  const d = deployment();
  const state = await populate(d);
  // The receipts of a host that went away mid-command: nothing is running any more, and the only
  // thing that settles them is the repair pass the operations document tells the owner to run. It
  // must not be gated by the rule that exists to stop a *copy* of state that may still be changing.
  const nodeStore = new Database(join(d.paths.nodeDataDir, "agent-process-operations.sqlite"));
  nodeStore
    .prepare("UPDATE agent_process_operations SET state='started' WHERE operation_id=?")
    .run(state.operationId);
  nodeStore.close();
  // The command completes: it is the repair pass that settles what nobody could confirm, and it is
  // not the operation this gate is about.
  await expect(backup(["reconcile", d.configPath], serviceStub({}))).resolves.toBeDefined();
  // The same state still refuses a fresh copy, which is the whole point of the gate.
  await expect(backup(["backup", d.configPath, d.checkpoint])).rejects.toThrow(/命令/);
});

it("leaves no backup when a service could not be confirmed stopped", async () => {
  const d = deployment();
  await populate(d);
  await expect(
    backup(
      ["backup", d.configPath, d.checkpoint],
      serviceStub({ node: { state: "unconfirmed", pid: 7, remaining: 7 } }),
    ),
  ).rejects.toThrow(/未能确认停止/);
  // The owner's command really failed, and it published nothing that could be read as a backup.
  expect(existsSync(d.checkpoint)).toBe(false);
});

it("leaves no backup when a stopped service could not confirm it ended its commands", async () => {
  const d = deployment();
  await populate(d);
  await expect(
    backup(
      ["backup", d.configPath, d.checkpoint],
      // The service is gone, but it said a command it had started may still be running: the
      // workspace can still be written, so a checkpoint taken now would copy state mid-change.
      serviceStub({ node: { state: "stopped", pid: 7, unconfirmedCommands: 2 } }),
    ),
  ).rejects.toThrow(/命令/);
  expect(existsSync(d.checkpoint)).toBe(false);
});

it("leaves nothing that verifies when the backup process is killed while it copies", async () => {
  const d = deployment();
  await populate(d);
  // Real bytes, so the copy is still running when the kill lands instead of a race the check has to
  // hope it wins: the whole file is copied and hashed before the backup can finish.
  const chunk = Buffer.alloc(1024 * 1024, 7),
    large = join(d.paths.controlPlaneDataDir, "zz-large-state.bin");
  for (let index = 0; index < 64; index++) appendFileSync(large, chunk);
  const entry = resolve("dist/src/deployment/cli.js");
  expect(existsSync(entry), "pnpm build must run before this check").toBe(true);
  const child = spawn(process.execPath, [entry, "backup", d.configPath, d.checkpoint], {
    stdio: "ignore",
  });
  children.push(child);
  const copied = join(d.checkpoint, "control");
  const deadline = Date.now() + 30_000;
  while (!existsSync(copied) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
  expect(existsSync(copied), "the backup never began copying").toBe(true);
  expect(child.kill("SIGKILL"), "the backup had already finished before it could be killed").toBe(
    true,
  );
  await new Promise((r) => child.once("exit", r));
  // Everything the killed process had written is still there, and none of it is a backup.
  expect(existsSync(join(d.checkpoint, "complete.json"))).toBe(false);
  expect(() => verifyCoordinatedCheckpoint(d.checkpoint)).toThrow(/incomplete/i);
});
