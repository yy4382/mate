import {
  queueUncertainOperationFacts,
  parseHistory,
  workspaceOperationSummary,
} from "../control-plane/operation-recovery-context.js";
import { AgentSession } from "../control-plane/agent-session.js";
import Database from "better-sqlite3";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { controlPlaneSchema } from "../control-plane/schema.js";
import { readAgentWorkspaceIdentity } from "../nodes/agent-provisioner.js";
import { agentProcessOperationSchema } from "../nodes/process-operations.js";
import { openControlPlaneDatabase } from "../storage/initialize.js";
import { type CoordinatedStatePaths } from "./coordinated-checkpoint.js";
import {
  reconcileRecoveryState,
  type NodeRecoveryOperation,
  type RecoveryAgent,
  type RecoveryOperation,
  type RecoveryOperationKind,
} from "./reconcile-state.js";

const identitySchema = z
  .object({ id: z.string().uuid(), privateKey: z.string().min(1).max(8192) })
  .strict();
const uuidSchema = z.string().uuid();

interface AgentRow {
  id: string;
  node_id: string;
  linux_username: string | null;
  uid: number | null;
  gid: number | null;
  home: string | null;
  home_marker: string | null;
}

interface ProcessReceiptRow {
  operation_id: string;
  agent_id: string;
  request_hash: string;
  request: string;
  state: "started" | "succeeded" | "failed" | "unknown";
  receipt: string | null;
  revision: number | null;
}

interface OperationTarget {
  kind: RecoveryOperationKind;
  agentId: string;
  operationId: string;
  row: Record<string, unknown>;
}

export interface CoordinatedReconciliationReport {
  nodeId: string;
  checkedOperations: number;
  confirmed: number;
  holds: Array<{ agentId: string; reason: string }>;
  released: string[];
}

export interface CoordinatedReconciliationDependencies {
  lookupAgentIdentity?: (
    agentId: string,
    workspaceRoot: string,
  ) => {
    username: string;
    uid: number;
    gid: number;
    workspace: string;
    workspaceMarker: string;
  };
  now?: () => number;
}

/** Compare the restored control-plane SQLite state with this machine's real node receipts. */
export function reconcileCoordinatedState(
  paths: CoordinatedStatePaths,
  dependencies: CoordinatedReconciliationDependencies = {},
): CoordinatedReconciliationReport {
  const now = dependencies.now ?? Date.now,
    lookupIdentity = dependencies.lookupAgentIdentity ?? readAgentWorkspaceIdentity,
    controlPlanePath = join(paths.controlPlaneDataDir, "control-plane.sqlite"),
    nodeIdentity = readNodeIdentity(join(paths.nodeDataDir, "node-identity.json")),
    processPath = join(paths.nodeDataDir, "agent-process-operations.sqlite"),
    { controlPlane, processDb } = openRecoveryStores(controlPlanePath, processPath);
  let checkedOperations = 0;
  try {
    const pairedNode = controlPlane
      .prepare("SELECT id,public_key FROM nodes WHERE id=?")
      .get(nodeIdentity.id) as { id: string; public_key: string } | undefined;
    // An Agent is proven against its node's recorded account plus its own workspace; a node that
    // never completed a preparation has no account recorded, so nothing is verified for it.
    const rows = controlPlane
      .prepare(
        `SELECT a.id,a.node_id,n.linux_username,n.uid,n.gid,a.home,a.home_marker
         FROM owner_agents a JOIN nodes n ON n.id=a.node_id`,
      )
      .all() as AgentRow[];
    const localHomes = new Set(
      readdirSync(paths.agentHomeRoot).filter((name) => uuidSchema.safeParse(name).success),
    );
    const localHomeAgents = rows.filter(
      (row) => localHomes.has(row.id) && row.home === join(paths.agentHomeRoot, row.id),
    );
    const controlAgents = rows.map(toRecoveryAgent),
      localAgentIds = [
        ...new Set([
          ...rows.filter((row) => row.node_id === nodeIdentity.id).map((row) => row.id),
          ...localHomeAgents.map((row) => row.id),
        ]),
      ],
      localById = new Map(rows.map((row) => [row.id, row])),
      verifiedAgents: RecoveryAgent[] = [];
    for (const row of rows) {
      if (row.node_id !== nodeIdentity.id) continue;
      try {
        const identity = lookupIdentity(row.id, paths.agentHomeRoot);
        if (
          identity.workspace !== row.home ||
          identity.username !== row.linux_username ||
          identity.uid !== row.uid ||
          identity.gid !== row.gid ||
          identity.workspaceMarker !== row.home_marker
        )
          continue;
        if (row.node_id === nodeIdentity.id)
          verifiedAgents.push({ ...toRecoveryAgent(row), username: identity.username });
      } catch {
        // An unreadable account or home holds just this Agent; other node identities still reconcile.
      }
    }

    const controlOperations: RecoveryOperation[] = [],
      nodeOperations: NodeRecoveryOperation[] = [],
      targets = new Map<string, OperationTarget>(),
      invalidReceiptAgents = new Map<string, string>(),
      invalidNodeFacts: Array<{
        agentId: string;
        operationId: string;
        request: unknown;
        reason: string;
      }> = [],
      invalidWorkspaceOperationIds = new Set<string>(),
      workspaceOperationAgents = new Map<string, string>();
    let unassociatedWorkspaceReceipt = false;

    for (const row of readProcessReceiptsChecked(processDb, processPath)) {
      const parsed = parseNodeProcessRequest(row);
      if (!parsed || !parseHistory(row.receipt).ok) {
        invalidNodeFacts.push({
          agentId: row.agent_id,
          operationId: row.operation_id,
          request: parseHistory(row.request).value,
          reason: "node_receipt_identity_unproven",
        });
        invalidReceiptAgents.set(row.agent_id, "node_receipt_identity_unproven");
        continue;
      }
      nodeOperations.push({
        operationId: row.operation_id,
        agentId: row.agent_id,
        kind: parsed.kind,
        requestHash: row.request_hash,
        request: parseJsonOrNull(row.request) ?? row.request,
        state: row.state,
        receipt: parseJsonOrNull(row.receipt),
        sequence: row.revision ?? 0,
      });
    }
    for (const entry of readWorkspaceReceipts(join(paths.nodeDataDir, "workspace-receipts"))) {
      if (!entry.ok) {
        if (entry.agentId)
          invalidReceiptAgents.set(entry.agentId, "node_receipt_identity_unproven");
        if (entry.operationId) invalidWorkspaceOperationIds.add(entry.operationId);
        if (!entry.agentId && !entry.operationId) unassociatedWorkspaceReceipt = true;
        continue;
      }
      const receipt = entry.receipt;
      if (
        !uuidSchema.safeParse(receipt.operationId).success ||
        !uuidSchema.safeParse(receipt.agentId).success
      ) {
        if (typeof receipt.agentId === "string")
          invalidReceiptAgents.set(receipt.agentId, "node_receipt_identity_unproven");
        if (typeof receipt.operationId === "string")
          invalidWorkspaceOperationIds.add(receipt.operationId);
        if (typeof receipt.agentId !== "string" && typeof receipt.operationId !== "string")
          unassociatedWorkspaceReceipt = true;
        continue;
      }
      const normalized = normalizeWorkspaceReceipt(receipt.state, receipt.result);
      if (receipt.state === "succeeded" && normalized === null) {
        invalidReceiptAgents.set(receipt.agentId, "node_receipt_identity_unproven");
        invalidWorkspaceOperationIds.add(receipt.operationId);
        continue;
      }
      nodeOperations.push({
        operationId: receipt.operationId,
        agentId: receipt.agentId,
        kind: "workspace",
        requestHash: receipt.requestHash,
        state: receipt.state === "executing" ? "started" : receipt.state,
        receipt: normalized,
        sequence: receipt.revision,
      });
    }

    for (const row of readProcessIntents(controlPlane, nodeIdentity.id)) {
      const kind = processIntentKind(row.request_json);
      if (!kind) {
        invalidReceiptAgents.set(row.agent_id, "control_receipt_identity_unproven");
        continue;
      }
      const requestHash = expectedProcessHash(row.agent_id, row.request_json);
      addIntent(
        controlOperations,
        targets,
        {
          kind,
          operationId: row.operation_id,
          agentId: row.agent_id,
          nodeId: row.node_id,
          requestHash,
          request: parseJsonOrNull(row.request_json) ?? row.request_json,
          state: row.state,
          receiptConfirmed: row.node_receipt_confirmed === 1,
          nodeReceiptRevision: row.node_receipt_revision,
          receipt: parseJsonOrNull(row.receipt_json),
        },
        { kind, agentId: row.agent_id, operationId: row.operation_id, row },
      );
    }
    for (const row of readStopIntents(controlPlane, nodeIdentity.id)) {
      const requestHash = hashJson({
        agentId: row.agent_id,
        operation: { kind: "process.stop_all" },
      });
      addIntent(
        controlOperations,
        targets,
        {
          kind: "stop",
          operationId: row.operation_id,
          agentId: row.agent_id,
          nodeId: row.node_id,
          requestHash,
          state: row.state,
          receiptConfirmed: row.node_receipt_revision !== null,
          nodeReceiptRevision: row.node_receipt_revision,
          receipt: parseJsonOrNull(row.receipt_json),
        },
        { kind: "stop", agentId: row.agent_id, operationId: row.operation_id, row },
      );
    }
    for (const row of readWorkspaceIntents(controlPlane, nodeIdentity.id)) {
      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(row.result_json) as Record<string, unknown>;
        if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
          throw new Error("Invalid envelope");
      } catch {
        invalidReceiptAgents.set(row.agent_id, "control_receipt_identity_unproven");
        continue;
      }
      if (typeof envelope.operationId === "string")
        workspaceOperationAgents.set(envelope.operationId, row.agent_id);
      const state = normalizeWorkspaceState(envelope.state);
      if (
        !state ||
        typeof envelope.operationId !== "string" ||
        !uuidSchema.safeParse(envelope.operationId).success
      ) {
        invalidReceiptAgents.set(row.agent_id, "control_receipt_identity_unproven");
        continue;
      }
      const requestHash =
        typeof envelope.nodeRequestHash === "string" ? envelope.nodeRequestHash : "";
      if (!validHash(requestHash)) {
        invalidReceiptAgents.set(row.agent_id, "control_receipt_identity_unproven");
        continue;
      }
      addIntent(
        controlOperations,
        targets,
        {
          kind: "workspace",
          request: workspaceOperationSummary(
            controlPlane,
            row.agent_id,
            envelope.operationId,
            row.operation,
          ),
          operationId: envelope.operationId,
          agentId: row.agent_id,
          nodeId: nodeIdentity.id,
          requestHash,
          state,
          receiptConfirmed: Number.isSafeInteger(envelope.revision),
          nodeReceiptRevision: validRevision(envelope.revision) ?? null,
          receipt: workspaceControlReceipt(envelope),
        },
        {
          kind: "workspace",
          agentId: row.agent_id,
          operationId: envelope.operationId,
          row: { ...row, envelope },
        },
      );
    }

    for (const operationId of invalidWorkspaceOperationIds) {
      const owner = workspaceOperationAgents.get(operationId);
      if (owner) invalidReceiptAgents.set(owner, "node_receipt_identity_unproven");
      else unassociatedWorkspaceReceipt = true;
    }
    if (unassociatedWorkspaceReceipt)
      for (const agentId of localAgentIds)
        invalidReceiptAgents.set(agentId, "node_receipt_identity_unproven");

    const controlState = {
        nodeId: nodeIdentity.id,
        nodePublicKey: pairedNode?.public_key ?? "",
        agents: controlAgents,
        operations: controlOperations,
      },
      nodeState = {
        nodeId: nodeIdentity.id,
        nodePublicKey: nodeIdentity.publicKey,
        agents: verifiedAgents,
        operations: nodeOperations,
      },
      decision = reconcileRecoveryState(controlState, nodeState),
      holds = new Map(decision.holds.map((entry) => [entry.agentId, entry.reason]));
    for (const row of localHomeAgents)
      if (row.node_id !== nodeIdentity.id) holds.set(row.id, "node_identity_unproven");
    for (const agent of localAgentIds)
      if (!pairedNode || pairedNode.public_key !== nodeIdentity.publicKey)
        holds.set(agent, "node_identity_unproven");

    for (const agentId of localAgentIds)
      if (!controlPlane.prepare("SELECT 1 FROM owner_agent_sessions WHERE agent_id=?").get(agentId))
        holds.set(agentId, "agent_session_unavailable");

    const confirmed = decision.confirmed;
    checkedOperations = nodeOperations.length + controlOperations.length;
    let applied = 0;
    controlPlane
      .transaction(() => {
        const session = new AgentSession(controlPlane);
        for (const fact of invalidNodeFacts)
          if (localById.has(fact.agentId))
            session.queueCorrection(
              fact.agentId,
              {
                ...fact,
                state: "unknown",
                note: "历史证据无法核实；旧命令仍可能运行。不会自动重放。",
              },
              now(),
            );
        for (const fact of decision.uncertainties)
          if (localById.has(fact.agentId))
            session.queueCorrection(
              fact.agentId,
              {
                ...fact,
                state: "unknown",
                note:
                  fact.kind === "workspace"
                    ? "历史文件效果无法确认；不会自动重放。由你决定检查、补救或继续。"
                    : "旧命令仍可能运行；不会自动重放。由你决定检查、补救或继续。",
              },
              now(),
            );
        for (const [agent, reason] of invalidReceiptAgents)
          if (localById.has(agent))
            session.queueCorrection(
              agent,
              {
                state: "unknown",
                reason,
                note: "部分历史操作信息无法解析；旧命令仍可能运行。不会自动重放；由你决定检查、补救或继续。",
              },
              now(),
            );
        for (const receipt of confirmed) {
          const target = targets.get(key(receipt.kind, receipt.operationId));
          if (!target) continue;
          applyReceipt(controlPlane, target, receipt, now());
          applied++;
        }
        for (const agentId of localAgentIds)
          queueUncertainOperationFacts(controlPlane, agentId, now());
        const upsert = controlPlane.prepare(`
          INSERT INTO owner_agent_recovery_holds(agent_id,reason,updated_at) VALUES(?,?,?)
          ON CONFLICT(agent_id) DO UPDATE SET reason=excluded.reason,updated_at=excluded.updated_at
        `);
        for (const [id, reason] of holds) if (localById.has(id)) upsert.run(id, reason, now());
        const release = controlPlane.prepare(
          "DELETE FROM owner_agent_recovery_holds WHERE agent_id=?",
        );
        const held = new Set(holds.keys());
        for (const id of localAgentIds) if (!held.has(id)) release.run(id);
      })
      .immediate();
    return {
      nodeId: nodeIdentity.id,
      checkedOperations,
      confirmed: applied,
      holds: [...holds].map(([agentId, reason]) => ({ agentId, reason })),
      released: localAgentIds.filter((id) => !holds.has(id)),
    };
  } finally {
    controlPlane.close();
    processDb.close();
  }
}

function readNodeIdentity(path: string): { id: string; publicKey: string } {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error("Node identity must be a protected regular file");
  const saved = identitySchema.parse(JSON.parse(readFileSync(path, "utf8"))),
    privateKey = createPrivateKey(saved.privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("Node identity key must use Ed25519");
  return {
    id: saved.id,
    publicKey: createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString(),
  };
}

function toRecoveryAgent(row: AgentRow): RecoveryAgent {
  return {
    id: row.id,
    nodeId: row.node_id,
    uid: row.uid ?? 0,
    gid: row.gid ?? 0,
    home: row.home ?? "",
    homeMarker: row.home_marker ?? "",
    ...(row.linux_username ? { username: row.linux_username } : {}),
  };
}

function readProcessReceipts(database: Database.Database): ProcessReceiptRow[] {
  assertSqliteTable(database, "agent_process_operations");
  const hasRevision = hasColumn(database, "agent_process_operations", "revision"),
    revision = hasRevision ? "revision" : "NULL AS revision";
  return database
    .prepare(
      `SELECT operation_id,agent_id,request_hash,request,state,receipt,${revision}
    FROM agent_process_operations ORDER BY operation_id`,
    )
    .all() as ProcessReceiptRow[];
}

type WorkspaceReceipt = {
  operationId: string;
  agentId: string;
  requestHash: string;
  state: "executing" | "succeeded" | "failed" | "unknown";
  result?: unknown;
  revision: number;
};

type WorkspaceReceiptRead =
  { ok: true; receipt: WorkspaceReceipt } | { ok: false; operationId?: string; agentId?: string };

function readWorkspaceReceipts(directory: string): WorkspaceReceiptRead[] {
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0)
    throw new Error("Workspace receipt directory must be private and real");
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name): WorkspaceReceiptRead => {
      const operationId = name.slice(0, -5),
        namedOperationId = uuidSchema.safeParse(operationId).success ? operationId : undefined,
        path = join(directory, name);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
          return { ok: false, ...(namedOperationId ? { operationId: namedOperationId } : {}) };
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown,
          agentId =
            typeof raw === "object" &&
            raw !== null &&
            "agentId" in raw &&
            typeof (raw as { agentId?: unknown }).agentId === "string"
              ? (raw as { agentId: string }).agentId
              : undefined,
          result = z
            .object({
              operationId: z.string(),
              agentId: z.string(),
              requestHash: z.string(),
              state: z.enum(["executing", "succeeded", "failed", "unknown"]),
              result: z.unknown().optional(),
              revision: z.number().int().positive().optional(),
            })
            .passthrough()
            .safeParse(raw);
        if (!result.success)
          return {
            ok: false,
            ...(namedOperationId ? { operationId: namedOperationId } : {}),
            ...(agentId ? { agentId } : {}),
          };
        return { ok: true, receipt: { ...result.data, revision: result.data.revision ?? 0 } };
      } catch {
        return { ok: false, ...(namedOperationId ? { operationId: namedOperationId } : {}) };
      }
    });
}

function readProcessIntents(
  database: Database.Database,
  nodeId: string,
): Array<Record<string, any>> {
  return database
    .prepare(
      `SELECT operation_id,agent_id,node_id,request_json,state,receipt_json,
      node_receipt_confirmed,node_receipt_revision FROM owner_agent_process_operations WHERE node_id=?`,
    )
    .all(nodeId) as Array<Record<string, any>>;
}

function readStopIntents(database: Database.Database, nodeId: string): Array<Record<string, any>> {
  return database
    .prepare(
      `SELECT operation_id,agent_id,node_id,state,receipt_json,node_receipt_revision
    FROM owner_agent_stop_intents WHERE node_id=?`,
    )
    .all(nodeId) as Array<Record<string, any>>;
}

function readWorkspaceIntents(
  database: Database.Database,
  nodeId: string,
): Array<Record<string, any>> {
  return database
    .prepare(
      `SELECT action.agent_id,action.operation,action.result_json,action.session_id,action.action_id,agent.node_id
    FROM owner_agent_tool_actions action JOIN owner_agents agent ON agent.id=action.agent_id
    WHERE agent.node_id=? AND action.operation LIKE 'workspace.%'`,
    )
    .all(nodeId) as Array<Record<string, any>>;
}

function addIntent(
  operations: RecoveryOperation[],
  targets: Map<string, OperationTarget>,
  operation: RecoveryOperation,
  target: OperationTarget,
): void {
  operations.push(operation);
  targets.set(key(operation.kind, operation.operationId), target);
}

function processIntentKind(requestJson: string): RecoveryOperationKind | undefined {
  try {
    const request = JSON.parse(requestJson) as { operation?: unknown };
    const operation = agentProcessOperationSchema.parse(request.operation);
    return operation.kind === "process.stop_all" ? "stop" : "process";
  } catch {
    return undefined;
  }
}

function expectedProcessHash(agentId: string, requestJson: string): string {
  try {
    const request = JSON.parse(requestJson) as { operation?: unknown },
      operation = agentProcessOperationSchema.parse(request.operation);
    return hashJson({ agentId, operation });
  } catch {
    return "";
  }
}

function parseNodeProcessRequest(
  row: ProcessReceiptRow,
): { kind: RecoveryOperationKind } | undefined {
  if (!validHash(row.request_hash)) return undefined;
  try {
    const request = JSON.parse(row.request) as { agentId?: unknown; operation?: unknown },
      operation = agentProcessOperationSchema.parse(request.operation);
    if (
      request.agentId !== row.agent_id ||
      createHash("sha256").update(row.request).digest("hex") !== row.request_hash
    )
      return undefined;
    return { kind: operation.kind === "process.stop_all" ? "stop" : "process" };
  } catch {
    return undefined;
  }
}

function normalizeWorkspaceState(state: unknown): RecoveryOperation["state"] | undefined {
  return state === "executing" || state === "unknown" || state === "succeeded" || state === "failed"
    ? state
    : undefined;
}

function workspaceControlReceipt(envelope: Record<string, unknown>): unknown | null {
  return envelope.result ?? null;
}

function normalizeWorkspaceReceipt(state: string, result: unknown): unknown | null {
  if (state === "succeeded") {
    if (!result || typeof result !== "object") return null;
    try {
      return JSON.parse((result as { stdout: string }).stdout);
    } catch {
      return null;
    }
  }
  if (state === "failed" && result && typeof result === "object") {
    const value = result as { code?: number; stderr?: string };
    return { code: value.code ?? 1, stderr: value.stderr ?? "" };
  }
  return result ?? null;
}

function applyReceipt(
  database: Database.Database,
  target: OperationTarget,
  receipt: NodeRecoveryOperation,
  now: number,
): void {
  if (target.kind === "process") {
    database
      .prepare(
        `UPDATE owner_agent_process_operations SET state=?,receipt_json=?,
        node_receipt_confirmed=1,node_receipt_revision=?,updated_at=? WHERE operation_id=? AND node_id=?`,
      )
      .run(
        receipt.state,
        stringifyOrNull(receipt.receipt),
        receipt.sequence,
        now,
        target.operationId,
        (target.row as { node_id: string }).node_id,
      );
    new AgentSession(database).queueCorrection(
      target.agentId,
      { operationId: receipt.operationId, state: receipt.state, receipt: receipt.receipt },
      now,
    );
  } else if (target.kind === "stop")
    database
      .prepare(
        `UPDATE owner_agent_stop_intents SET state=?,receipt_json=?,node_receipt_revision=?,updated_at=?
        WHERE operation_id=? AND node_id=?`,
      )
      .run(
        receipt.state,
        stringifyOrNull(receipt.receipt),
        receipt.sequence,
        now,
        target.operationId,
        (target.row as { node_id: string }).node_id,
      );
  else {
    const row = target.row as { envelope: Record<string, unknown> };
    const workspace = receipt.receipt as { code?: number; stderr?: string } | null;
    let state: "succeeded" | "failed" = receipt.state === "succeeded" ? "succeeded" : "failed",
      result: unknown,
      error: string | undefined;
    if (state === "succeeded") {
      result = receipt.receipt;
    } else {
      result = { code: workspace?.code ?? 1, stderr: workspace?.stderr ?? "" };
      error = workspace?.stderr ?? "Workspace operation failed";
    }
    const envelope = JSON.stringify({
      ...row.envelope,
      state,
      result,
      ...(error ? { error } : {}),
      revision: receipt.sequence,
    }).slice(0, 100_000);
    database
      .prepare(
        `UPDATE owner_agent_tool_actions SET result_json=? WHERE session_id=? AND action_id=? AND agent_id=?`,
      )
      .run(
        envelope,
        (target.row as { session_id: string }).session_id,
        (target.row as { action_id: string }).action_id,
        target.agentId,
      );

    new AgentSession(database).queueCorrection(
      target.agentId,
      { operationId: receipt.operationId, operation: row.envelope.operation, state, result, error },
      now,
    );
  }
}

function readNodeProcessState(database: Database.Database, path: string): void {
  const result = database.prepare("PRAGMA integrity_check").get() as
    Record<string, string> | undefined;
  if (!result || Object.values(result)[0] !== "ok")
    throw new Error(`SQLite integrity check failed: ${path}`);
}

function openRecoveryStores(
  controlPlanePath: string,
  processPath: string,
): {
  controlPlane: Database.Database;
  processDb: Database.Database;
} {
  let controlPlane: Database.Database | undefined, processDb: Database.Database | undefined;
  try {
    assertSqliteIntegrity(controlPlanePath);
    processDb = openProtectedDatabase(processPath);
    readNodeProcessState(processDb, processPath);
    controlPlane = openControlPlaneDatabase(controlPlanePath, controlPlaneSchema);
    return { controlPlane, processDb };
  } catch (error) {
    if (controlPlane?.open) controlPlane.close();
    if (processDb?.open) processDb.close();
    throw error;
  }
}

function assertSqliteIntegrity(path: string): void {
  const database = openProtectedDatabase(path);
  try {
    readNodeProcessState(database, path);
  } finally {
    database.close();
  }
}

function openProtectedDatabase(path: string): Database.Database {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error(`SQLite state must be a private regular file: ${path}`);
  return new Database(path, { readonly: true, fileMustExist: true });
}

function assertSqliteTable(database: Database.Database, name: string): void {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
    throw new Error(`Required node receipt table is missing: ${name}`);
}

function hasColumn(database: Database.Database, table: string, name: string): boolean {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (row) => row.name === name,
  );
}

function parseJsonOrNull(value: string | null): unknown | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function stringifyOrNull(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validHash(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function validRevision(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function key(kind: RecoveryOperationKind, operationId: string): string {
  return `${kind}:${operationId}`;
}

function parseNodeProcessState(database: Database.Database, path: string): void {
  readNodeProcessState(database, path);
}

function readProcessReceiptsChecked(
  database: Database.Database,
  path: string,
): ProcessReceiptRow[] {
  parseNodeProcessState(database, path);
  return readProcessReceipts(database);
}
