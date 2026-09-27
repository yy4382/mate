import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExecutionBackend, ExecutionResult, Operation } from "../execution/backend.js";
import { LinuxUserBackend, type LinuxIdentity } from "../execution/linux-user.js";
import { readAgentWorkspaceIdentity, type AgentWorkspaceIdentity } from "./agent-provisioner.js";
import { workspaceReceiptRequestHash } from "./workspace-receipt.js";

export type WorkspaceMode = "owner_read" | "agent_read" | "agent_action" | "agent_publish";

export interface WorkspaceExecutionRequest {
  operationId: string;
  agentId: string;
  mode: WorkspaceMode;
  operation: Exclude<Operation, { kind: "exec" }>;
}

export interface WorkspaceExecutionDependencies {
  lookupIdentity?: (agentId: string, workspaceRoot: string) => AgentWorkspaceIdentity;
  createBackend?: (agentId: string, identity: LinuxIdentity) => ExecutionBackend;
  now?: () => number;
}

interface StoredReceipt {
  operationId: string;
  agentId: string;
  requestHash: string;
  state: "executing" | "succeeded" | "failed" | "unknown";
  result?: ExecutionResult;
  revision: number;
  updatedAt: number;
}

const mutatingKinds = new Set<Operation["kind"]>([
  "write_bytes",
  "write",
  "edit",
  "mkdir",
  "move",
  "remove",
]);
const readKinds = new Set<Operation["kind"]>([
  "workspace_list",
  "workspace_stat",
  "workspace_read_chunk",
]);
const agentReadKinds = new Set<Operation["kind"]>([...readKinds, "read"]);

/** Executes file requests under the fixed Linux account assigned to the Agent. */
export class LinuxWorkspaceExecutor {
  private readonly receiptsDirectory: string;
  private readonly lookupIdentity: (
    agentId: string,
    workspaceRoot: string,
  ) => AgentWorkspaceIdentity;
  private readonly createBackend: (agentId: string, identity: LinuxIdentity) => ExecutionBackend;
  private readonly now: () => number;
  private readonly active = new Map<
    string,
    { requestHash: string; promise: Promise<ExecutionResult> }
  >();

  constructor(
    private readonly homeRoot: string,
    dataDirectory: string,
    dependencies: WorkspaceExecutionDependencies = {},
  ) {
    if (!isAbsolute(homeRoot) || !isAbsolute(dataDirectory))
      throw new Error("Node paths must be absolute");
    this.receiptsDirectory = join(resolve(dataDirectory), "workspace-receipts");
    mkdirSync(this.receiptsDirectory, { recursive: true, mode: 0o700 });
    const receiptDirectory = lstatSync(this.receiptsDirectory);
    if (!receiptDirectory.isDirectory() || receiptDirectory.isSymbolicLink())
      throw new Error("Node operation receipts require a real directory");
    if ((receiptDirectory.mode & 0o077) !== 0)
      throw new Error("Node operation receipt directory is accessible by other users");
    this.lookupIdentity = dependencies.lookupIdentity ?? readAgentWorkspaceIdentity;
    this.createBackend =
      dependencies.createBackend ??
      ((agentId, identity) => new LinuxUserBackend({ [agentId]: identity }));
    this.now = dependencies.now ?? Date.now;
  }

  execute(request: WorkspaceExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    validateRequest(request);
    const requestHash = workspaceReceiptRequestHash(request.agentId, request.operation),
      existingCall = this.active.get(request.operationId);
    if (existingCall)
      return existingCall.requestHash === requestHash
        ? existingCall.promise
        : Promise.resolve(
            failed("operation_conflict: Operation ID was reused for another file request"),
          );
    const operation = this.executeOnce(request, requestHash, signal).finally(() => {
      if (this.active.get(request.operationId)?.promise === operation)
        this.active.delete(request.operationId);
    });
    this.active.set(request.operationId, { requestHash, promise: operation });
    return operation;
  }

  /** Read only durable terminal evidence. A running operation is never waited on here. */
  status(agentId: string, operationId: string): ExecutionResult | undefined {
    const receipt = this.readReceipt(operationId);
    if (!receipt || receipt.agentId !== agentId || receipt.state === "executing") return undefined;
    return receipt.result;
  }

  /** Read the durable local version for a workspace operation without changing its result. */
  receiptRevision(agentId: string, operationId: string): number | undefined {
    const receipt = this.readReceipt(operationId);
    if (!receipt || receipt.agentId !== agentId || !Number.isSafeInteger(receipt.revision))
      return undefined;
    return receipt.revision;
  }

  private async executeOnce(
    request: WorkspaceExecutionRequest,
    requestHash: string,
    signal?: AbortSignal,
  ): Promise<ExecutionResult> {
    const records = mutatingKinds.has(request.operation.kind),
      existing = records ? this.readReceipt(request.operationId) : undefined;
    if (existing) {
      if (existing.agentId !== request.agentId || existing.requestHash !== requestHash)
        return failed("operation_conflict: Operation ID was reused for another file request");
      if (
        existing.state === "succeeded" ||
        existing.state === "failed" ||
        existing.state === "unknown"
      )
        return (
          existing.result ?? failed("operation_unknown: The file operation result is unavailable")
        );
      const result = failed(
        "operation_unknown: A previous node process stopped during this operation",
      );
      this.writeReceipt({
        ...existing,
        state: "unknown",
        result,
        revision: (existing.revision ?? 1) + 1,
        updatedAt: this.now(),
      });
      return result;
    }

    const identity = this.lookupIdentity(request.agentId, this.homeRoot);
    if (resolve(identity.workspace) !== identity.workspace)
      return failed("identity_mismatch: Agent workspace is not canonical");
    const expectedWorkspace = join(resolve(this.homeRoot), request.agentId.toLowerCase());
    if (identity.workspace !== expectedWorkspace)
      return failed("identity_mismatch: Agent workspace does not match its stable ID");
    if (records)
      this.writeReceipt({
        operationId: request.operationId,
        agentId: request.agentId,
        requestHash,
        state: "executing",
        revision: 1,
        updatedAt: this.now(),
      });

    let result: ExecutionResult;
    try {
      result = await this.createBackend(request.agentId, {
        username: identity.username,
        uid: identity.uid,
        gid: identity.gid,
        home: identity.workspace,
      }).execute(
        {
          root: identity.workspace,
          operation: request.operation,
          timeoutMs: 60_000,
          agentId: request.agentId,
        },
        signal,
      );
    } catch {
      result = failed("operation_unknown: The node could not confirm the file operation result");
      if (records)
        this.writeReceipt({
          operationId: request.operationId,
          agentId: request.agentId,
          requestHash,
          state: "unknown",
          result,
          revision: 2,
          updatedAt: this.now(),
        });
      return result;
    }

    if (records)
      this.writeReceipt({
        operationId: request.operationId,
        agentId: request.agentId,
        requestHash,
        state:
          result.code === 0
            ? "succeeded"
            : result.stderr.startsWith("operation_unknown:")
              ? "unknown"
              : "failed",
        result,
        revision: 2,
        updatedAt: this.now(),
      });
    return result;
  }

  private readReceipt(operationId: string): StoredReceipt | undefined {
    const path = this.receiptPath(operationId);
    if (!existsSync(path)) return undefined;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error("Node operation receipt is not a protected regular file");
    return JSON.parse(readFileSync(path, "utf8")) as StoredReceipt;
  }

  private writeReceipt(receipt: StoredReceipt): void {
    const path = this.receiptPath(receipt.operationId),
      temp = `${path}.${process.pid}.${this.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }

  private receiptPath(operationId: string): string {
    return join(this.receiptsDirectory, `${operationId}.json`);
  }
}

function validateRequest(request: WorkspaceExecutionRequest): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.operationId))
    throw new Error("Workspace operation ID must be a UUID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.agentId))
    throw new Error("Workspace Agent ID must be a UUID");
  if (request.mode === "agent_action" && !mutatingKinds.has(request.operation.kind))
    throw new Error("Agent file action must change workspace state");
  if (request.mode === "agent_read" && !agentReadKinds.has(request.operation.kind))
    throw new Error("Agent read requests must be read-only");
  if (
    (request.mode === "owner_read" || request.mode === "agent_publish") &&
    !readKinds.has(request.operation.kind)
  )
    throw new Error("Owner browsing and file publishing allow read operations only");
}

function failed(stderr: string): ExecutionResult {
  return { code: 1, stdout: "", stderr: stderr.slice(0, 240), truncated: false };
}
