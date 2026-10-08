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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  workspaceResultIsUnknown,
  type WorkspaceFailureCode,
  type Operation,
  type AgentWorkspaceIdentity,
  type ControlWorkspaceOperation,
} from "@mate/protocol";
import type { ExecutionBackend, ExecutionResult } from "./file-execution.js";
import { SameAccountFileBackend, type FileExecutionAccount } from "./same-account-files.js";
import { within } from "./path-resolution.js";
import { readAgentWorkspaceIdentity } from "../provisioning/agent-workspace.js";

import { workspaceReceiptRequestHash } from "@mate/protocol/node";
import { z } from "zod";

export type WorkspaceMode = ControlWorkspaceOperation["mode"];

export type WorkspaceExecutionRequest = Pick<
  ControlWorkspaceOperation,
  "operationId" | "agentId" | "mode" | "operation"
>;

export interface WorkspaceExecutionDependencies {
  lookupIdentity?: (agentId: string, workspaceRoot: string) => AgentWorkspaceIdentity;
  createBackend?: (identity: FileExecutionAccount) => ExecutionBackend;
  now?: () => number;
  /** Fault pause after real execution, before durable terminal evidence, for integration tests. */
  beforeReceipt?: () => Promise<void>;
}

// Durable receipts retain extension fields and pre-revision records. Captured output may be
// larger than a wire response; only sendWorkspaceOperationResult applies the wire text limits.
const storedReceiptSchema = z.looseObject({
  operationId: z.string(),
  agentId: z.string(),
  requestHash: z.string(),
  // An unfamiliar historical state remains unproven and follows the existing unknown-effect path.
  state: z.string(),
  result: z
    .looseObject({
      code: z.number(),
      stdout: z.string(),
      stderr: z.string(),
      truncated: z.boolean(),
    })
    .optional(),
  revision: z.number().optional(),
  updatedAt: z.number().optional(),
});
type StoredReceipt = z.infer<typeof storedReceiptSchema>;

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

/** Executes file requests as the node account after verifying the Agent workspace identity. */
export class LinuxWorkspaceExecutor {
  private readonly receiptsDirectory: string;
  private readonly lookupIdentity: (
    agentId: string,
    workspaceRoot: string,
  ) => AgentWorkspaceIdentity;
  private readonly createBackend: (identity: FileExecutionAccount) => ExecutionBackend;
  private readonly now: () => number;
  private readonly beforeReceipt: (() => Promise<void>) | undefined;
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
      dependencies.createBackend ?? ((identity) => new SameAccountFileBackend(identity));
    this.now = dependencies.now ?? Date.now;
    this.beforeReceipt = dependencies.beforeReceipt;
  }

  execute(request: WorkspaceExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    validateRequest(request);
    const requestHash = workspaceReceiptRequestHash(request.agentId, request.operation);
    // The mode decides which workspace a read runs in, so the same operation ID under another
    // mode is another request and may not share this in-flight result. Durable receipts identify
    // filesystem mutations by Agent and operation; read modes do not produce receipts.
    const key = `${request.mode}\0${request.operationId}`;
    const existingCall = this.active.get(key);
    if (existingCall)
      return existingCall.requestHash === requestHash
        ? existingCall.promise
        : Promise.resolve(
            failed(
              "operation_conflict",
              "operation_conflict: Operation ID was reused for another file request",
            ),
          );
    const operation = this.executeOnce(request, requestHash, signal).finally(() => {
      if (this.active.get(key)?.promise === operation) this.active.delete(key);
    });
    this.active.set(key, { requestHash, promise: operation });
    return operation;
  }

  /** Read only durable terminal evidence. A running operation is never waited on here. */
  status(agentId: string, operationId: string, requestHash?: string): ExecutionResult | undefined {
    const receipt = this.readReceipt(operationId);
    if (!receipt || receipt.agentId !== agentId || receipt.state === "executing") return undefined;
    if (
      receipt.operationId !== operationId ||
      !["succeeded", "failed", "unknown"].includes(receipt.state)
    )
      throw new Error("Historical file receipt identity or state is invalid");
    if (requestHash !== undefined && requestHash !== receipt.requestHash)
      return failed(
        "operation_unknown",
        "operation_unknown: Historical file request does not match the receipt",
      );
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
    const records = mutatingKinds.has(request.operation.kind);
    const existing = records ? this.readReceipt(request.operationId) : undefined;
    if (existing) {
      if (existing.agentId !== request.agentId || existing.requestHash !== requestHash)
        return failed(
          "operation_conflict",
          "operation_conflict: Operation ID was reused for another file request",
        );
      if (
        existing.state === "succeeded" ||
        existing.state === "failed" ||
        existing.state === "unknown"
      )
        return (
          existing.result ??
          failed("operation_unknown", "operation_unknown: The file operation result is unavailable")
        );
      const result = failed(
        "operation_unknown",
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
      return failed("workspace_unavailable", "identity_mismatch: Agent workspace is not canonical");
    const expectedWorkspace = join(resolve(this.homeRoot), request.agentId.toLowerCase());
    if (identity.workspace !== expectedWorkspace)
      return failed(
        "workspace_unavailable",
        "identity_mismatch: Agent workspace does not match its stable ID",
      );
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
      const sharedRead = selectAgentReadWorkspace({
        mode: request.mode,
        operation: request.operation,
        workspace: identity.workspace,
        workspaceRoot: resolve(this.homeRoot),
      });
      result = await this.createBackend({
        username: identity.username,
        uid: identity.uid,
        gid: identity.gid,
        home: identity.workspace,
      }).execute(
        {
          root: sharedRead?.root ?? identity.workspace,
          operation: sharedRead?.operation ?? request.operation,
          timeoutMs: 60_000,
          agentId: request.agentId,
        },
        signal,
      );
    } catch {
      result = failed(
        "operation_unknown",
        "operation_unknown: The node could not confirm the file operation result",
      );
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

    if (records && this.beforeReceipt) await this.beforeReceipt();
    if (records)
      this.writeReceipt({
        operationId: request.operationId,
        agentId: request.agentId,
        requestHash,
        state: receiptState(result),
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
    return storedReceiptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }

  private writeReceipt(receipt: StoredReceipt): void {
    const path = this.receiptPath(receipt.operationId);
    const temp = `${path}.${process.pid}.${this.now()}.tmp`;
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

/**
 * Where one Agent read operation really runs, and the path it runs with. An Agent's file tools are
 * not confined to its own directory: Mate asks the Agent in its prompt not to browse a peer's
 * workspace casually, and then leaves that judgement to it, so a read of another Agent's workspace
 * runs with the shared workspace root instead of being refused.
 *
 * Reachable directories are exactly the ones the node provisions under that root: the Agent's own
 * workspace, and a peer workspace named by its stable Agent ID (`agentWorkspacePath`). The root
 * itself and anything else under it are not a workspace, so they stay refused even if an operator
 * points the root at a directory that also holds the node's own files. Paths are handed on relative
 * to the root they run under, so a path that resolves inside the Agent's own workspace is not
 * refused for the spelling it arrived in.
 *
 * Only reads move. Writing, publishing and the owner's preview keep their own root: the owner's
 * preview of a selected Agent must not leave that Agent's directory, and a file change must stay
 * inside the workspace whose operation receipt records it. Mate's confinement stays the file
 * helper's job; this only chooses which workspace a permitted read runs in.
 */
function selectAgentReadWorkspace({
  mode,
  operation,
  workspace,
  workspaceRoot,
}: Pick<WorkspaceExecutionRequest, "mode" | "operation"> & {
  workspace: string;
  workspaceRoot: string;
}): { root: string; operation: Operation } | undefined {
  if (mode !== "agent_read" || !agentReadKinds.has(operation.kind)) return undefined;
  const target = resolve(workspace, operation.path);
  const own = within(workspace, target);
  if (own) {
    const ownPath = relative(workspace, target);
    return { root: workspace, operation: { ...operation, path: ownPath === "" ? "." : ownPath } };
  }
  if (!within(workspaceRoot, target)) return undefined;
  const peerPath = relative(workspaceRoot, target);
  const peerName = peerPath.split(sep)[0] ?? "";
  if (!agentDirectoryName.test(peerName) || !isWorkspaceDirectory(join(workspaceRoot, peerName)))
    return undefined;
  return { root: workspaceRoot, operation: { ...operation, path: peerPath } };
}

/**
 * One Agent's workspace directory under the shared root, named by its stable Agent ID exactly as
 * `agentWorkspacePath` spells it. Mate never creates an Agent directory under another name, so a
 * differently spelled or differently cased neighbour is not a peer workspace.
 */
const agentDirectoryName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A peer's workspace must be the real directory the node provisions, never a file or a link. */
function isWorkspaceDirectory(path: string): boolean {
  try {
    // `lstatSync`: a symbolic link to a directory is not a workspace directory.
    return lstatSync(path).isDirectory();
  } catch {
    return false;
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

function receiptState(result: ExecutionResult) {
  if (result.code === 0) return "succeeded";
  return workspaceResultIsUnknown(result) ? "unknown" : "failed";
}

function failed(errorCode: WorkspaceFailureCode, stderr: string): ExecutionResult {
  return { code: 1, errorCode, stdout: "", stderr: stderr.slice(0, 240), truncated: false };
}
