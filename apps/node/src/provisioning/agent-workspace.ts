import {
  AgentProvisionStageSchema,
  type AgentProvisionStage,
  type AgentWorkspaceIdentity,
  type NodeControlMessage,
  type NodeRequest,
} from "@mate/protocol";
import {
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { systemErrorCode } from "../system-error.js";
import { AgentProvisioningError } from "./errors.js";
import { ensureWorkspaceMarker, verifyWorkspaceMarker } from "./workspace-marker.js";
export { AgentProvisioningError, type AgentProvisionFailureCode } from "./errors.js";

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
  "# Agent memory\n\nThis file is the entry point to your own memory and workspace notes.\n";
const activePreparations = new Map<string, Promise<AgentWorkspaceIdentity>>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the running account's real identity. Mate never switches identity, so the node and every
 * ordinary command it starts report the same username, UID and GID. Root is refused here rather than
 * reported: this release never runs the node as root, and every Agent on the node would otherwise
 * be created with root as its account.
 */
export function nodeAccountIdentity(): Pick<AgentWorkspaceIdentity, "username" | "uid" | "gid"> {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const gid = typeof process.getgid === "function" ? process.getgid() : -1;
  if (uid === 0 || gid === 0)
    throw new AgentProvisioningError(
      "unsupported_host",
      "节点正以 root 运行。这个版本要求控制面与节点以现有普通账号运行；请改用该账号启动节点后重试。",
    );
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
  const key = `${resolve(options.workspaceRoot)}\0${options.agentId.toLowerCase()}`;
  const running = activePreparations.get(key);
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
  const account = nodeAccountIdentity();
  const workspace = agentWorkspacePath(workspaceRoot, agentId);
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
  const account = nodeAccountIdentity();
  const agentId = options.agentId.toLowerCase();
  const workspaceRoot = resolve(options.workspaceRoot);
  const workspace = agentWorkspacePath(workspaceRoot, agentId);
  const progress = (stage: AgentProvisionStage) => options.onProgress?.(stage);

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
  const root = resolve(path);
  const parent = dirname(root);
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
    const code = systemErrorCode(error);
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
    if (systemErrorCode(error) !== "EEXIST")
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
    const template = Buffer.from(initialMemory);
    const interruptedCreate =
      contents.length <= template.length && template.subarray(0, contents.length).equals(contents);
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
