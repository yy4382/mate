import { assistantEntry } from "../helpers/session.js";
/**
 * The owner's restore path, at the seam the owner actually uses: the `restore` command of the
 * ordinary-account deployment CLI, over real control-plane, node and workspace stores, with only
 * the two service processes stubbed.
 *
 * The ticket this covers asks for three things a passing happy path does not establish:
 *
 * 1. Only a checkpoint that verifies is restored, and a damaged or incomplete one never produces a
 *    "restore succeeded" report — the live deployment is left exactly as it was found.
 * 2. What continues after a restore: the Agent's ID and default workspace, its one logical session,
 *    its pending message deliveries, its open task and its reminder; and the restored node key is
 *    still the key the control plane paired, so the node authenticates again and the page shows it.
 * 3. A command result nobody could prove stays recorded and unknown instead of being replayed as if
 *    it had never run, while the receipts a restore replaces stay readable where the report says.
 */
import Database from "better-sqlite3";
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentDirectory } from "../../src/control-plane/agents/directory.js";
import { createControlPlaneApp } from "../../src/control-plane/http.js";
import type { NodeSocket } from "../../src/control-plane/nodes/directory.js";
import { OwnerAuth } from "../../src/control-plane/owner-auth.js";
import { OwnerChat } from "../../src/control-plane/owner-chat.js";
import { deploymentMain, type DeploymentServices } from "../../src/deployment/cli.js";
import {
  RECOVERY_MARKER,
  verifyCoordinatedCheckpoint,
} from "../../src/deployment/coordinated-checkpoint.js";
import {
  prepareAgentWorkspace,
  readAgentWorkspaceIdentity,
} from "../../src/nodes/agent-provisioner.js";
import { AgentProcessOperations } from "../../src/nodes/process-operations.js";
import { initializeCoordinatedRoots } from "../helpers/coordinated-state.js";

const roots: string[] = [];
const apps: Array<{ close(): void }> = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const agentId = "11111111-1111-4111-8111-111111111111";
const ownerPassword = "synthetic-owner-password-for-the-restore-check";
const commandOperation = { kind: "exec" as const, command: "printf done", cwd: "." };

interface Deployment {
  root: string;
  paths: { controlPlaneDataDir: string; nodeDataDir: string; agentHomeRoot: string };
  nodeId: string;
  configPath: string;
  ownerPasswordFile: string;
  checkpoint: string;
  workspace: string;
}

function controlPlanePath(d: Deployment): string {
  return join(d.paths.controlPlaneDataDir, "control-plane.sqlite");
}

/** One ordinary-account deployment's real stores, plus the configuration its own commands use. */
function deployment(): Deployment {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-restore-checkpoint-")));
  roots.push(root);
  const paths = {
    controlPlaneDataDir: join(root, "data", "control-plane"),
    nodeDataDir: join(root, "data", "node"),
    agentHomeRoot: join(root, "data", "agents"),
  };
  const node = initializeCoordinatedRoots(paths),
    ownerPasswordFile = join(root, "owner-password"),
    configPath = join(root, "deploy.json");
  writeFileSync(ownerPasswordFile, `${ownerPassword}\n`, { mode: 0o600 });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        version: 1,
        publicOrigin: "https://mate.example.test",
        controlPlanePort: 4599,
        releaseRoot: join(root, "app"),
        stateDir: join(root, "state"),
        ...paths,
        ownerPasswordFile,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return {
    root,
    paths,
    nodeId: node.nodeId,
    configPath,
    ownerPasswordFile,
    checkpoint: join(root, "backup"),
    workspace: join(paths.agentHomeRoot, agentId),
  };
}

/** What the owner really has after using this deployment: an Agent with work still in flight. */
async function populate(d: Deployment): Promise<{
  messageId: string;
  deliveryId: string;
  taskId: string;
  reminderId: string;
  knownOperationId: string;
}> {
  const auth = new OwnerAuth({
    dataDir: d.paths.controlPlaneDataDir,
    passwordFile: d.ownerPasswordFile,
  });
  // The owner's password is provisioned before the disaster; after a restore the same password has
  // to sign in from the restored database alone.
  expect(await auth.passwordHash()).toBeTruthy();
  auth.close();

  const identity = await prepareAgentWorkspace({ agentId, workspaceRoot: d.paths.agentHomeRoot });
  writeFileSync(join(identity.workspace, "ledger.txt"), "once\n", { mode: 0o600 });

  const control = new Database(controlPlanePath(d)),
    chat = new OwnerChat(control, () => 1_000),
    directory = new AgentDirectory(control, () => 1_000);
  directory.prepare({
    id: agentId,
    nodeId: d.nodeId,
    name: "恢复检查同事",
    role: "恢复后继续未完成的工作",
    description: "Synthetic restore fixture.",
    model: { provider: "openai", id: "gpt-4o-mini" },
  });
  directory.complete(agentId, identity, chat);
  const channel = chat.createChannel({
    name: "恢复检查",
    description: "恢复后这里的事实必须还在",
    visibility: "private",
  });
  expect(chat.inviteAgentToChannel(channel.id, agentId)).toBe(true);
  const message = chat.createMessage(channel.id, "恢复后这条消息、任务和提醒仍在。")!,
    task = chat.createTaskForMessage(message.id, "human", "owner"),
    delivery = control
      .prepare(
        "SELECT id FROM owner_message_deliveries WHERE message_id=? AND recipient_kind='agent' AND recipient_id=?",
      )
      .get(message.id, agentId) as { id: string },
    reminderId = randomUUID();
  // The reminder store the reminder feature really writes; `listAgentReminders` and
  // `fireDueReminders` below are the interfaces that read and act on it.
  control
    .prepare(
      `INSERT INTO owner_reminders(id,agent_id,channel_id,task_id,text,due_at,state,created_at,updated_at)
       VALUES(?,?,?,?,?,?,'active',1,1)`,
    )
    .run(reminderId, agentId, channel.id, task.id, "恢复后提醒仍会触发", 1);
  const knownOperationId = addCommand(control, d, {
    control: {
      state: "succeeded",
      receipt: { code: 0, stdout: "done" },
      confirmed: true,
      revision: 2,
    },
    node: { state: "succeeded", receipt: { code: 0, stdout: "done" }, revision: 2 },
  });
  control.close();
  return {
    messageId: message.id,
    deliveryId: delivery.id,
    taskId: task.id,
    reminderId,
    knownOperationId,
  };
}

/**
 * One ordinary command as both sides really record it: a durable control-plane intent plus the
 * node's own durable receipt. `control` is the verdict the control plane had reached (its stored
 * receipt and the node revision it was proven at), and `node` is what the node's store holds.
 */
function addCommand(
  control: Database.Database,
  d: Deployment,
  input: {
    control: {
      state: "executing" | "unknown" | "succeeded" | "failed";
      receipt: unknown | null;
      confirmed: boolean;
      revision: number | null;
    };
    node: {
      state: "started" | "unknown" | "succeeded" | "failed";
      receipt: unknown;
      revision: number;
    };
  },
): string {
  const operationId = randomUUID(),
    request = JSON.stringify({ agentId, operation: commandOperation }),
    requestHash = createHash("sha256").update(request).digest("hex"),
    delivery = control
      .prepare(
        "SELECT id FROM owner_message_deliveries WHERE recipient_kind='agent' AND recipient_id=? LIMIT 1",
      )
      .get(agentId) as { id: string },
    runId = randomUUID();
  control
    .prepare(
      `INSERT INTO owner_agent_runs(id,agent_id,node_id,delivery_id,state,started_at)
       VALUES(?,?,?,?,'completed',1)`,
    )
    .run(runId, agentId, d.nodeId, delivery.id);
  const entry = assistantEntry("  preserved response\n");
  control
    .prepare(
      "INSERT INTO owner_agent_session_records(id,agent_id,run_id,action_scope_id,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,1)",
    )
    .run(entry.id, agentId, runId, delivery.id, entry.kind, JSON.stringify(entry));
  control
    .prepare(
      `INSERT INTO owner_agent_process_operations(
         operation_id,run_id,agent_id,node_id,action_scope_id,stable_action_id,
         request_hash,request_json,state,receipt_json,node_receipt_confirmed,node_receipt_revision,
         created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,1)`,
    )
    .run(
      operationId,
      runId,
      agentId,
      d.nodeId,
      delivery.id,
      `mate:${delivery.id}:${"a".repeat(64)}:1`,
      requestHash,
      request,
      input.control.state,
      input.control.receipt === null ? null : JSON.stringify(input.control.receipt),
      input.control.confirmed ? 1 : 0,
      input.control.revision,
    );
  const node = new Database(join(d.paths.nodeDataDir, "agent-process-operations.sqlite"));
  try {
    node
      .prepare(
        `INSERT INTO agent_process_operations(
           operation_id,agent_id,request_hash,request,state,receipt,revision,created_at,updated_at
         ) VALUES(?,?,?,?,?,?,?,1,1)`,
      )
      .run(
        operationId,
        agentId,
        requestHash,
        request,
        input.node.state,
        JSON.stringify(input.node.receipt),
        input.node.revision,
      );
  } finally {
    node.close();
  }
  return operationId;
}

/** One more command, recorded on both sides after the checkpoint was taken. */
function lateCommand(d: Deployment, nodeReceipt: unknown): string {
  const control = new Database(controlPlanePath(d));
  try {
    return addCommand(control, d, {
      control: { state: "succeeded", receipt: nodeReceipt, confirmed: true, revision: 2 },
      node: { state: "succeeded", receipt: nodeReceipt, revision: 2 },
    });
  } finally {
    control.close();
  }
}

function readNodeReceipt(
  nodeDataDir: string,
  operationId: string,
): { state: string; receipt: string | null; revision: number } | undefined {
  const node = new Database(join(nodeDataDir, "agent-process-operations.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return node
      .prepare("SELECT state,receipt,revision FROM agent_process_operations WHERE operation_id=?")
      .get(operationId) as { state: string; receipt: string | null; revision: number } | undefined;
  } finally {
    node.close();
  }
}

function readControlIntent(
  d: Deployment,
  operationId: string,
): Record<string, unknown> | undefined {
  const control = new Database(controlPlanePath(d), { readonly: true, fileMustExist: true });
  try {
    return control
      .prepare(
        `SELECT state,receipt_json,node_receipt_confirmed,node_receipt_revision
         FROM owner_agent_process_operations WHERE operation_id=?`,
      )
      .get(operationId) as Record<string, unknown> | undefined;
  } finally {
    control.close();
  }
}

/** The two service processes, stubbed: what matters is when they are stopped and started. */
function serviceStub(
  calls: string[],
  hooks: { onStop?: () => void; onStart?: () => void } = {},
): DeploymentServices {
  const reports = {
    "control-plane": { state: "running" as const, pid: 11, startedAt: 1 },
    node: { state: "running" as const, pid: 12, startedAt: 1 },
  };
  return {
    start: async () => {
      hooks.onStart?.();
      calls.push("start");
      return { reports };
    },
    stop: async () => {
      hooks.onStop?.();
      calls.push("stop");
      return {
        reports: {
          "control-plane": { state: "stopped" as const, pid: 11 },
          node: { state: "stopped" as const, pid: 12 },
        },
      };
    },
    restart: async () => ({ reports }),
    reports: () => reports,
  };
}

/** Run one documented owner command and read back the report it printed. */
async function runCli(
  args: string[],
  calls: string[] = [],
  hooks: { onStop?: () => void; onStart?: () => void } = {},
): Promise<{ report: Record<string, any>; output: string }> {
  const output: string[] = [];
  await deploymentMain(args, {
    services: () => serviceStub(calls, hooks),
    write: (text) => output.push(text),
  });
  expect(output).toHaveLength(1);
  return { report: JSON.parse(output[0]!) as Record<string, any>, output: output[0]! };
}

class FakeNodeSocket implements NodeSocket {
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  terminate() {}
}

interface RestoredPage {
  app: ReturnType<typeof createControlPlaneApp>;
  cookie: string;
  messages: string[];
  nodeOnline: boolean;
  agentWorkspace: string | null;
}

/**
 * The real control plane over the restored state, with the restored node key authenticating the
 * way the node process does. Returns what the owner's page reports and what the control plane asked
 * the node to account for.
 */
async function openRestoredControlPlane(d: Deployment): Promise<RestoredPage> {
  const app = createControlPlaneApp({
    dataDir: d.paths.controlPlaneDataDir,
    passwordFile: d.ownerPasswordFile,
  });
  apps.push(app);
  const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: ownerPassword }),
    }),
    cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  expect(login.status).toBe(204);
  const saved = JSON.parse(
      readFileSync(join(d.paths.nodeDataDir, "node-identity.json"), "utf8"),
    ) as {
      privateKey: string;
    },
    socket = new FakeNodeSocket();
  app.nodes.open(socket);
  const challenge = JSON.parse(socket.sent[0]!) as { nonce: string };
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.authenticate",
      requestId: randomUUID(),
      nodeId: d.nodeId,
      signature: sign(
        null,
        Buffer.from(challenge.nonce),
        createPrivateKey(saved.privateKey),
      ).toString("base64url"),
    }),
  );
  const nodes = (await (await app.request("/api/owner/nodes", { headers: { cookie } })).json()) as {
      nodes: Array<{ id: string; online: boolean }>;
    },
    agents = (await (await app.request("/api/owner/agents", { headers: { cookie } })).json()) as {
      agents: Array<{ id: string; linuxIdentity: { workspace: string } | null }>;
    };
  return {
    app,
    cookie,
    messages: socket.sent,
    nodeOnline: nodes.nodes.find((node) => node.id === d.nodeId)?.online ?? false,
    agentWorkspace:
      agents.agents.find((agent) => agent.id === agentId)?.linuxIdentity?.workspace ?? null,
  };
}

async function authorizeModel(page: RestoredPage): Promise<number> {
  return (
    await page.app.request("/api/owner/model-credentials/openai", {
      method: "PUT",
      headers: { cookie: page.cookie, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "synthetic-key-restore-check" }),
    })
  ).status;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("refuses a checkpoint that is incomplete, altered or not a backup, and never reports a restore", async () => {
  const d = deployment();
  await populate(d);
  await runCli(["backup", d.configPath, d.checkpoint]);
  const verified = verifyCoordinatedCheckpoint(d.checkpoint);

  // What the live deployment looks like while the owner tries to restore: state that exists only
  // here, and must still exist afterwards if the checkpoint is refused.
  writeFileSync(join(d.paths.controlPlaneDataDir, "live-only.txt"), "still running\n", {
    mode: 0o600,
  });
  appendFileSync(join(d.workspace, "ledger.txt"), "changed after the backup\n");

  const incomplete = join(d.root, "incomplete"),
    altered = join(d.root, "altered"),
    empty = join(d.root, "not-a-backup"),
    missing = join(d.root, "never-written");
  cpSync(d.checkpoint, incomplete, { recursive: true });
  rmSync(join(incomplete, "complete.json"));
  cpSync(d.checkpoint, altered, { recursive: true });
  appendFileSync(join(altered, "homes", agentId, "ledger.txt"), "tampered\n");
  mkdirSync(empty, { mode: 0o700 });
  rmSync(missing, { recursive: true, force: true });

  for (const [label, bad] of [
    ["a checkpoint whose completion marker is missing", incomplete],
    ["a checkpoint whose bytes changed after it was written", altered],
    ["a directory that is not a backup", empty],
    ["a path that was never written", missing],
  ] as const) {
    const calls: string[] = [];
    let failure: unknown;
    try {
      await runCli(["restore", d.configPath, bad], calls);
    } catch (error) {
      failure = error;
    }
    expect(failure, `${label} was restored`).toBeInstanceOf(Error);
    expect((failure as Error).message, label).toMatch(/incomplete|integrity|readable directory/i);
    // Nothing was stopped for a checkpoint that never verified, so a refused restore cannot take a
    // running deployment down on its way out, and no report was printed that could be read as
    // success.
    expect(calls, label).toEqual([]);
    // The live deployment is exactly as the owner left it.
    expect(existsSync(join(d.paths.controlPlaneDataDir, "live-only.txt")), label).toBe(true);
    expect(readFileSync(join(d.workspace, "ledger.txt"), "utf8"), label).toBe(
      "once\nchanged after the backup\n",
    );
    expect(existsSync(join(d.paths.controlPlaneDataDir, RECOVERY_MARKER)), label).toBe(false);
    expect(existsSync(`${d.paths.controlPlaneDataDir}.${RECOVERY_MARKER}`), label).toBe(false);
    expect(existsSync(join(d.paths.nodeDataDir, RECOVERY_MARKER)), label).toBe(false);
  }
  // The checkpoint itself was never modified by the refusals, so the owner can still use it.
  expect(verifyCoordinatedCheckpoint(d.checkpoint).id).toBe(verified.id);
});

it("refuses to restore into a data directory this deployment does not have, without stopping anything", async () => {
  const d = deployment();
  await populate(d);
  await runCli(["backup", d.configPath, d.checkpoint]);
  const verified = verifyCoordinatedCheckpoint(d.checkpoint);
  // The likeliest way to point a restore at the wrong host: a configured data directory that does
  // not exist here.
  rmSync(d.paths.agentHomeRoot, { recursive: true, force: true });
  const calls: string[] = [];
  await expect(runCli(["restore", d.configPath, d.checkpoint], calls)).rejects.toThrow(
    /Restore destination must be a real directory/,
  );
  // The refusal names the path and is the whole result: nothing was stopped for it, nothing was
  // created in place of the missing directory, and the checkpoint is still usable.
  expect(calls).toEqual([]);
  expect(existsSync(d.paths.agentHomeRoot)).toBe(false);
  expect(verifyCoordinatedCheckpoint(d.checkpoint).id).toBe(verified.id);
});

it("restores the Agent, its one session, pending deliveries, open task and reminder, and reconnects the node", async () => {
  const d = deployment();
  const state = await populate(d);
  await runCli(["backup", d.configPath, d.checkpoint]);
  const verified = verifyCoordinatedCheckpoint(d.checkpoint);

  // The disaster: the workspace loses the file that makes it this Agent's, and the live state gains
  // a message and a task that belong after the checkpoint.
  rmSync(join(d.workspace, "MEMORY.md"));
  appendFileSync(join(d.workspace, "ledger.txt"), "after the backup\n");
  const lateControl = new Database(controlPlanePath(d)),
    lateChat = new OwnerChat(lateControl, () => 2_000),
    lateChannel = lateChat.createChannel({
      name: "备份之后",
      description: "",
      visibility: "private",
    }),
    lateMessage = lateChat.createMessage(lateChannel.id, "这条消息在检查点之后。")!;
  lateChat.createTaskForMessage(lateMessage.id, "human", "owner");
  lateControl.close();

  const calls: string[] = [],
    observed: { atStop?: string; atStart?: boolean } = {};
  const { report } = await runCli(["restore", d.configPath, d.checkpoint], calls, {
    onStop: () => {
      observed.atStop = readFileSync(join(d.workspace, "ledger.txt"), "utf8");
    },
    onStart: () => {
      observed.atStart = existsSync(join(d.workspace, "MEMORY.md"));
    },
  });

  // The command reports which verified checkpoint it applied, what it kept of the state it
  // replaced, and that nothing was left held.
  expect(report).toMatchObject({
    checkpoint: d.checkpoint,
    id: verified.id,
    checkedOperations: 2,
    confirmed: 0,
    holds: [],
    released: [agentId],
  });
  expect(report.previous).toEqual(
    expect.arrayContaining([
      `${d.paths.controlPlaneDataDir}.mate-before-${verified.id}`,
      `${d.paths.nodeDataDir}.mate-before-${verified.id}`,
      `${d.paths.agentHomeRoot}.mate-before-${verified.id}`,
    ]),
  );

  // Both services stopped before the live roots were replaced, and came back after reconciliation.
  expect(calls).toEqual(["stop", "start"]);
  expect(observed.atStop).toBe("once\nafter the backup\n");
  expect(observed.atStart).toBe(true);
  expect(report.services).toMatchObject({
    "control-plane": { state: "running" },
    node: { state: "running" },
  });

  // The Agent keeps its ID and its own default workspace, with the file set it was created with,
  // and the confirmed receipt of the command it had already run is preserved on both sides.
  const identity = readAgentWorkspaceIdentity(agentId, d.paths.agentHomeRoot);
  expect(identity.workspace).toBe(d.workspace);
  expect(readFileSync(join(d.workspace, "ledger.txt"), "utf8")).toBe("once\n");
  expect(existsSync(join(d.workspace, "MEMORY.md"))).toBe(true);
  expect(readNodeReceipt(d.paths.nodeDataDir, state.knownOperationId)).toEqual({
    state: "succeeded",
    receipt: JSON.stringify({ code: 0, stdout: "done" }),
    revision: 2,
  });
  expect(readControlIntent(d, state.knownOperationId)).toEqual({
    state: "succeeded",
    receipt_json: JSON.stringify({ code: 0, stdout: "done" }),
    node_receipt_confirmed: 1,
    node_receipt_revision: 2,
  });

  // One logical session, with the journal it already had, and the delivery, task and reminder the
  // Agent still has to work on.
  const control = new Database(controlPlanePath(d), { readonly: true, fileMustExist: true }),
    sessions = control
      .prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?")
      .all(agentId) as Array<{ id: string }>;
  expect(sessions).toHaveLength(1);
  expect(control.prepare("SELECT COUNT(*) AS rows FROM owner_agent_sessions").get()).toMatchObject({
    rows: 1,
  });
  expect(
    control
      .prepare(
        "SELECT json_extract(payload_json,'$.message.content[0].text') AS text FROM owner_agent_session_records WHERE agent_id=?",
      )
      .get(agentId),
  ).toEqual({ text: "  preserved response\n" });
  control.close();

  const chatDb = new Database(controlPlanePath(d)),
    chat = new OwnerChat(chatDb, () => 3_000);

  expect(
    chat.listPendingDeliveries("agent", agentId).deliveries.map((delivery) => delivery.id),
  ).toEqual([state.deliveryId]);
  expect(chat.listTasks()).toMatchObject([{ id: state.taskId, status: "open" }]);
  expect(chat.taskForMessage(state.messageId)).toMatchObject({ id: state.taskId });
  expect(chat.listAgentReminders(agentId)).toMatchObject([
    { id: state.reminderId, state: "active" },
  ]);
  // A reminder still does its job after a restore: the due one fires, and the Agent's queue gains
  // the delivery that carries it.
  expect(chat.fireDueReminders()).toBe(1);
  expect(chat.listAgentReminders(agentId)).toMatchObject([
    {
      id: state.reminderId,
      state: "fired",
      firing: { firedAt: expect.any(Number), handledAt: null },
    },
  ]);
  expect(chat.listPendingDeliveries("agent", agentId).deliveries.map((d) => d.id)).toEqual([
    state.deliveryId,
    expect.any(String),
  ]);
  // The state that only existed after the checkpoint is gone, which is what a restore means.
  expect(chat.listChannels().some((channel) => channel.name === "备份之后")).toBe(false);
  chatDb.close();

  // The restored node identity is the key the control plane paired, so the node authenticates with
  // it and the owner's page reports it online and shows the restored workspace.
  const restoredIdentity = JSON.parse(
      readFileSync(join(d.paths.nodeDataDir, "node-identity.json"), "utf8"),
    ) as { id: string; privateKey: string },
    paired = new Database(controlPlanePath(d), { readonly: true, fileMustExist: true })
      .prepare("SELECT public_key FROM nodes WHERE id=?")
      .get(d.nodeId) as { public_key: string };
  expect(restoredIdentity.id).toBe(d.nodeId);
  expect(
    createPublicKey(createPrivateKey(restoredIdentity.privateKey))
      .export({ type: "spki", format: "pem" })
      .toString(),
  ).toBe(paired.public_key);
  const page = await openRestoredControlPlane(d);
  expect(page.nodeOnline).toBe(true);
  expect(page.agentWorkspace).toBe(d.workspace);
});

it("keeps an unknown command result and holds its Agent instead of replaying the command", async () => {
  const d = deployment();
  await populate(d);
  // The command the node began and could not finish: its own receipt settled at `unknown` when the
  // node restarted, and the control plane never received a verdict.
  const control = new Database(controlPlanePath(d)),
    unknownOperationId = addCommand(control, d, {
      control: { state: "executing", receipt: null, confirmed: false, revision: null },
      node: {
        state: "unknown",
        receipt: { reason: "node_restarted_during_operation" },
        revision: 2,
      },
    });
  control.close();

  // A settled unknown is not work still running: the owner can still take a checkpoint of this
  // deployment, which is what makes the restore path reachable for exactly this state.
  const { report: backup } = await runCli(["backup", d.configPath, d.checkpoint]);
  expect(typeof backup.id).toBe("string");
  const verified = verifyCoordinatedCheckpoint(d.checkpoint);

  // A command recorded after the checkpoint, whose receipt the restore will replace.
  const lateOperationId = lateCommand(d, { code: 0, stdout: "late" });

  const calls: string[] = [];
  const { report } = await runCli(["restore", d.configPath, d.checkpoint], calls);
  expect(calls).toEqual(["stop", "start"]);
  expect(report).toMatchObject({
    id: verified.id,
    // Both commands the checkpoint was taken for, on both sides, were read and accounted for.
    checkedOperations: 4,
    confirmed: 0,
    holds: [{ agentId, reason: "operation_result_unproven" }],
  });
  expect(report.released).not.toContain(agentId);

  // The node's own record is untouched: the same unknown, the same receipt, the same durable
  // version. Nothing reset it to `started` and nothing deleted it.
  expect(readNodeReceipt(d.paths.nodeDataDir, unknownOperationId)).toEqual({
    state: "unknown",
    receipt: JSON.stringify({ reason: "node_restarted_during_operation" }),
    revision: 2,
  });
  // The control plane claims no verdict either: it stays an unconfirmed intent rather than being
  // turned into a success or a failure the node never reported.
  expect(readControlIntent(d, unknownOperationId)).toEqual({
    state: "executing",
    receipt_json: null,
    node_receipt_confirmed: 0,
    node_receipt_revision: null,
  });
  // The Agent is durably held, which is what keeps a new run from starting for it.
  const holds = new Database(controlPlanePath(d), { readonly: true, fileMustExist: true });
  expect(
    holds
      .prepare("SELECT agent_id,reason FROM owner_agent_recovery_holds WHERE agent_id=?")
      .get(agentId),
  ).toEqual({ agent_id: agentId, reason: "operation_result_unproven" });
  holds.close();

  // Asking the node for that same operation again — which is what re-issuing the command would do —
  // is answered from the durable record instead of running the command a second time.
  const executed: string[] = [],
    node = new Database(join(d.paths.nodeDataDir, "agent-process-operations.sqlite")),
    operations = new AgentProcessOperations(node, async (request) => {
      executed.push(request.operation.kind);
      return { state: "succeeded", receipt: { code: 0 } };
    });
  try {
    expect(await operations.execute(agentId, unknownOperationId, commandOperation)).toMatchObject({
      state: "unknown",
      receipt: { reason: "node_restarted_during_operation" },
    });
    expect(executed).toEqual([]);
  } finally {
    node.close();
  }

  // The receipts the restore replaced are not lost: the report names where the replaced state went,
  // and the command recorded after the checkpoint is still readable there.
  const previousNodeDataDir = `${d.paths.nodeDataDir}.mate-before-${verified.id}`;
  expect(report.previous).toContain(previousNodeDataDir);
  expect(readNodeReceipt(previousNodeDataDir, lateOperationId)).toEqual({
    state: "succeeded",
    receipt: JSON.stringify({ code: 0, stdout: "late" }),
    revision: 2,
  });
  expect(readNodeReceipt(d.paths.nodeDataDir, lateOperationId)).toBeUndefined();

  // The restored control plane re-checks the unknown against the node's own record and starts no
  // new run for the held Agent, even with a model credential in place.
  const page = await openRestoredControlPlane(d);
  expect(await authorizeModel(page)).toBe(204);
  await delay(600);
  expect(
    page.messages.some(
      (text) =>
        text.includes('"type":"control.process.reconcile"') && text.includes(unknownOperationId),
    ),
  ).toBe(true);
  expect(page.messages.some((text) => text.includes('"type":"control.agent.run"'))).toBe(false);
});
