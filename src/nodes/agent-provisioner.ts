import { createHash, randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  AgentProvisionStageSchema,
  type AgentProvisionStage,
  type NodeControlMessage,
  type NodeRequest,
} from "./protocol.js";

export type AgentProvisionFailureCode =
  | "unsupported_host"
  | "permission_denied"
  | "account_conflict"
  | "identity_mismatch"
  | "filesystem_error";

/**
 * One Agent's default workspace plus the single host account that owns it. Mate runs the control
 * plane, the node, the model worker and every Agent command under the same ordinary account, so
 * this account identity is identical for every Agent on the node and is never created by Mate.
 */
export interface AgentWorkspaceIdentity {
  username: string;
  uid: number;
  gid: number;
  workspace: string;
  workspaceMarker: string;
}

export class AgentProvisioningError extends Error {
  constructor(
    readonly code: AgentProvisionFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentProvisioningError";
  }
}

export interface AgentWorkspacePreparationOptions {
  agentId: string;
  workspaceRoot: string;
  onProgress?: (stage: AgentProvisionStage) => void;
}

export type AgentWorkspaceRunner = (
  agentId: string,
  onProgress: (stage: AgentProvisionStage) => void,
) => Promise<AgentWorkspaceIdentity>;

const initialMemory =
  "# Agent memory\n\nThis file is the entry point to your private memory and workspace notes.\n";
const workspaceMarkerName = ".mate-workspace-id";
const workspaceMarkerStagingPattern = /^\.mate-workspace-id\.tmp-[0-9a-f]{32}$/;
const activePreparations = new Map<string, Promise<AgentWorkspaceIdentity>>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the running account's real identity. Mate never switches identity, so the node and every
 * model process it starts report the same username, UID and GID.
 */
export function nodeAccountIdentity(): { username: string; uid: number; gid: number } {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1,
    gid = typeof process.getgid === "function" ? process.getgid() : -1;
  let username: string;
  try {
    username = userInfo().username;
  } catch {
    username = `uid-${uid}`;
  }
  if (!username || username.includes("\0") || username.includes("/") || username.length > 255)
    throw new AgentProvisioningError("identity_mismatch", "节点无法确认当前运行账号的名称。");
  return { username, uid, gid };
}

/** Create or re-verify one Agent's default workspace under the running account. */
export async function prepareAgentWorkspace(
  options: AgentWorkspacePreparationOptions,
): Promise<AgentWorkspaceIdentity> {
  const key = `${resolve(options.workspaceRoot)}\0${options.agentId.toLowerCase()}`,
    running = activePreparations.get(key);
  if (running) return running;
  const operation = Promise.resolve()
    .then(() => prepareAgentWorkspaceOnce(options))
    .finally(() => {
      if (activePreparations.get(key) === operation) activePreparations.delete(key);
    });
  activePreparations.set(key, operation);
  return operation;
}

/** Read and verify an existing Agent workspace without creating or repairing anything. */
export function readAgentWorkspaceIdentity(
  agentId: string,
  workspaceRoot: string,
): AgentWorkspaceIdentity {
  verifyInputs(agentId, workspaceRoot);
  const account = nodeAccountIdentity(),
    workspace = agentWorkspacePath(workspaceRoot, agentId);
  verifyWorkspaceRoot(resolve(workspaceRoot));
  verifyWorkspaceDirectory(workspace);
  verifyMemoryEntry(workspace);
  return {
    ...account,
    workspace,
    workspaceMarker: verifyWorkspaceMarker(workspace),
  };
}

async function prepareAgentWorkspaceOnce(
  options: AgentWorkspacePreparationOptions,
): Promise<AgentWorkspaceIdentity> {
  verifyInputs(options.agentId, options.workspaceRoot);
  const account = nodeAccountIdentity(),
    agentId = options.agentId.toLowerCase(),
    workspaceRoot = resolve(options.workspaceRoot),
    workspace = agentWorkspacePath(workspaceRoot, agentId),
    progress = (stage: AgentProvisionStage) => options.onProgress?.(stage);

  progress("preparing_workspace");
  ensureWorkspaceRoot(workspaceRoot);
  ensureWorkspaceDirectory(workspace);
  // Claim and mark the workspace before writing anything into it: the marker is what makes this
  // directory provably this Agent's, so nothing else may be created until it exists.
  ensureWorkspaceMarker(workspace);
  ensureMemoryEntry(workspace);

  progress("verifying_workspace");
  verifyWorkspaceRoot(workspaceRoot);
  verifyWorkspaceDirectory(workspace);
  verifyMemoryEntry(workspace);
  return {
    ...account,
    workspace,
    workspaceMarker: verifyWorkspaceMarker(workspace),
  };
}

/** Turn one authenticated node request into progress and one bounded result message. */
export async function handleAgentProvisionRequest(
  request: Extract<NodeControlMessage, { type: "control.agent.provision" }>,
  send: (message: NodeRequest) => void,
  prepare: AgentWorkspaceRunner,
): Promise<boolean> {
  try {
    const identity = await prepare(request.agentId, (stage) => {
      const parsedStage = AgentProvisionStageSchema.parse(stage);
      send({
        type: "node.agent.provision.progress",
        requestId: request.requestId,
        agentId: request.agentId,
        stage: parsedStage,
      });
    });
    send({
      type: "node.agent.provision.result",
      requestId: request.requestId,
      agentId: request.agentId,
      ok: true,
      identity,
    });
  } catch (error) {
    const failure =
      error instanceof AgentProvisioningError
        ? error
        : new AgentProvisioningError(
            "filesystem_error",
            "Linux 节点无法完成 Agent 工作区核验，请检查节点状态后重试。",
          );
    send({
      type: "node.agent.provision.result",
      requestId: request.requestId,
      agentId: request.agentId,
      ok: false,
      code: failure.code,
      message: failure.message,
    });
  }
  return true;
}

/** A stable absolute workspace path for one Agent ID under the node's workspace root. */
export function agentWorkspacePath(workspaceRoot: string, agentId: string): string {
  if (!uuidPattern.test(agentId))
    throw new AgentProvisioningError("identity_mismatch", "Agent ID 格式无效。");
  return join(resolve(workspaceRoot), agentId.toLowerCase());
}

function verifyInputs(agentId: string, workspaceRoot: string): void {
  if (!isAbsolute(workspaceRoot))
    throw new AgentProvisioningError("filesystem_error", "Agent 工作区根路径必须是绝对路径。");
  if (!uuidPattern.test(agentId))
    throw new AgentProvisioningError("identity_mismatch", "Agent ID 格式无效。");
  if (resolve(workspaceRoot) === sep)
    throw new AgentProvisioningError(
      "filesystem_error",
      "Agent 工作区根路径不能是文件系统根目录。",
    );
}

/**
 * The workspace root is a directory the running account already controls. Preparing an Agent
 * creates one directory inside it; it never creates an account, elevates privilege, or touches a
 * path this account does not own. The root itself and the directory that holds it must be real
 * directories, so a workspace always lives where the operator pointed it.
 */
function ensureWorkspaceRoot(path: string): void {
  const root = resolve(path);
  try {
    mkdirSync(root, { mode: 0o700, recursive: true });
  } catch {
    throw unwritableRoot(root);
  }
  verifyWorkspaceRoot(root);
}

function verifyWorkspaceRoot(path: string): void {
  const root = resolve(path),
    parent = dirname(root);
  for (const current of parent === root ? [root] : [parent, root]) {
    const stat = lstatSafe(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new AgentProvisioningError(
        "identity_mismatch",
        `Agent 工作区根路径必须是真实目录（不能是符号链接）：${current}`,
      );
  }
}

function ensureWorkspaceDirectory(workspace: string): void {
  try {
    mkdirSync(workspace, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS")
      throw new AgentProvisioningError(
        "permission_denied",
        `节点无法在 Agent 工作区根路径下创建目录：${workspace}`,
      );
    if (code !== "EEXIST")
      throw new AgentProvisioningError(
        "filesystem_error",
        `节点无法创建 Agent 工作区：${workspace}`,
      );
  }
  const stat = lstatSafe(workspace);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new AgentProvisioningError("identity_mismatch", "Agent 工作区必须是真实目录。");
}

function verifyWorkspaceDirectory(workspace: string): void {
  const stat = lstatSafe(workspace);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new AgentProvisioningError("identity_mismatch", "Agent 工作区必须是真实目录。");
  if ((stat.mode & 0o077) !== 0)
    throw new AgentProvisioningError("identity_mismatch", "Agent 工作区不能允许其他用户访问。");
}

function ensureMemoryEntry(workspace: string): void {
  const path = join(workspace, "MEMORY.md");
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, initialMemory, "utf8");
    fsyncSync(fd);
    fchmodSync(fd, 0o600);
    closeSync(fd);
    return;
  } catch (error) {
    if (typeof fd === "number") closeSync(fd);
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      throw new AgentProvisioningError("filesystem_error", "节点无法准备 Agent 的 MEMORY.md。");
  }

  let existingFd: number;
  try {
    existingFd = openSync(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
  } catch {
    throw new AgentProvisioningError("identity_mismatch", "MEMORY.md 必须是真实普通文件。");
  }
  try {
    const stat = fstatSync(existingFd);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new AgentProvisioningError("identity_mismatch", "MEMORY.md 必须是真实普通文件。");
    let contents: Buffer;
    try {
      contents = readFileSync(existingFd);
    } catch {
      throw new AgentProvisioningError("filesystem_error", "节点无法读取 Agent 的 MEMORY.md。");
    }
    // An interrupted create may leave only a prefix of the template. Finish it rather than
    // overwriting notes the Agent has since written.
    const template = Buffer.from(initialMemory),
      interruptedCreate =
        contents.length <= template.length &&
        template.subarray(0, contents.length).equals(contents);
    if (interruptedCreate && contents.length < template.length) {
      try {
        rewriteInitialMemory(existingFd, template);
      } catch {
        throw new AgentProvisioningError("filesystem_error", "节点无法恢复 Agent 的 MEMORY.md。");
      }
    }
    fchmodSync(existingFd, 0o600);
  } catch (error) {
    if (error instanceof AgentProvisioningError) throw error;
    throw new AgentProvisioningError("filesystem_error", "节点无法保护 Agent 的 MEMORY.md。");
  } finally {
    closeSync(existingFd);
  }
}

function rewriteInitialMemory(fd: number, contents: Buffer): void {
  ftruncateSync(fd, 0);
  let offset = 0;
  while (offset < contents.length) {
    const written = writeSync(fd, contents, offset, contents.length - offset, offset);
    if (written <= 0) throw new Error("Could not finish MEMORY.md recovery");
    offset += written;
  }
  fsyncSync(fd);
}

function verifyMemoryEntry(workspace: string): void {
  let fd: number;
  try {
    fd = openSync(join(workspace, "MEMORY.md"), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new AgentProvisioningError("identity_mismatch", "Agent 工作区缺少可用的 MEMORY.md。");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
      throw new AgentProvisioningError(
        "identity_mismatch",
        "MEMORY.md 必须是权限为 600 的真实普通文件。",
      );
  } finally {
    closeSync(fd);
  }
}

function ensureWorkspaceMarker(workspace: string): void {
  const path = join(workspace, workspaceMarkerName);
  try {
    const final = lstatSync(path);
    if (final.nlink === 2) {
      // A crash may have happened after publishing the hard link but before removing its staging
      // name. Only remove the second link when it is the exact staged inode.
      verifyWorkspaceMarker(workspace, true);
      const stagedLinks = leftoverStagingFiles(workspace).filter((candidate) => {
        const stat = lstatSync(candidate);
        return stat.dev === final.dev && stat.ino === final.ino;
      });
      if (stagedLinks.length !== 1)
        throw new AgentProvisioningError("identity_mismatch", "Agent 工作区原身份标记链接无效。");
      unlinkSync(stagedLinks[0]!);
    }
    verifyWorkspaceMarker(workspace);
    syncDirectory(workspace);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // A crash before the hard link was published can leave its disposable staging file behind, either
  // empty (a crash between creating and writing it) or complete. Those files carry no identity yet,
  // so removing only them lets the same creation request finish. Each candidate must still be a
  // private regular file of the marker's own shape: a name Mate happens to recognise is not a
  // licence to delete whatever now sits under it.
  for (const staged of leftoverStagingFiles(workspace)) {
    let stat;
    try {
      stat = lstatSync(staged);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      (stat.size !== 0 && stat.size !== 65)
    )
      continue;
    try {
      unlinkSync(staged);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  // A workspace without Mate's marker is only recoverable while it holds nothing else, which is the
  // state a crash between creating the directory and publishing the marker leaves behind. Anything
  // else belongs to somebody else, and Mate reports it instead of adopting or erasing it.
  const remaining = readdirSync(workspace);
  if (remaining.length !== 0)
    throw new AgentProvisioningError(
      "identity_mismatch",
      `Agent 工作区目录已存在且含有其他内容：${workspace}（${remaining.slice(0, 5).join("、")}）。请换用空目录作为工作区根路径，或先处理该目录后重试。`,
    );

  // Stage the complete marker first. Only the hard link publishes the final name, so an interrupted
  // create can leave a disposable temporary file but never a partial marker.
  const staged = join(workspace, `${workspaceMarkerName}.tmp-${randomBytes(16).toString("hex")}`);
  let fd: number | undefined;
  try {
    fd = openSync(
      staged,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, `${randomBytes(32).toString("hex")}\n`, "utf8");
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(staged, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      verifyWorkspaceMarker(workspace);
    }
    unlinkSync(staged);
    syncDirectory(workspace);
  } catch (error) {
    if (error instanceof AgentProvisioningError) throw error;
    throw new AgentProvisioningError("filesystem_error", "节点无法建立 Agent 工作区标记。");
  } finally {
    if (typeof fd === "number") closeSync(fd);
    try {
      unlinkSync(staged);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Staging files an interrupted marker publication may have left in the workspace. */
function leftoverStagingFiles(workspace: string): string[] {
  return readdirSync(workspace)
    .filter((name) => workspaceMarkerStagingPattern.test(name))
    .map((name) => join(workspace, name));
}

function verifyWorkspaceMarker(workspace: string, allowStagedLink = false): string {
  let fd: number;
  try {
    fd = openSync(
      join(workspace, workspaceMarkerName),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch {
    throw new AgentProvisioningError(
      "identity_mismatch",
      "Agent 工作区已被其他内容占用：缺少 Mate 建立的原身份标记。请换用空目录作为工作区根路径。",
    );
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.nlink !== 1 && !(allowStagedLink && stat.nlink === 2)) ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size !== 65
    )
      throw new AgentProvisioningError("identity_mismatch", "Agent 工作区原身份标记无效。");
    const marker = readFileSync(fd, "utf8");
    if (!/^[0-9a-f]{64}\n$/.test(marker))
      throw new AgentProvisioningError("identity_mismatch", "Agent 工作区原身份标记无效。");
    return createHash("sha256").update(marker).digest("hex");
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string): void {
  const directory = openDirectory(path);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function openDirectory(path: string): number {
  try {
    return openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new AgentProvisioningError("identity_mismatch", "Agent 工作区必须是真实目录。");
  }
}

function unwritableRoot(parent: string): AgentProvisioningError {
  return new AgentProvisioningError(
    "permission_denied",
    `节点无法创建 Agent 工作区根路径：${parent}。请让运行账号可写，或用 MATE_NODE_AGENT_WORKSPACE_ROOT 指向一个属于它的目录。`,
  );
}

function lstatSafe(path: string) {
  try {
    return lstatSync(path);
  } catch {
    throw new AgentProvisioningError("filesystem_error", `节点无法检查路径：${path}`);
  }
}
