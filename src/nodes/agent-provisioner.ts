import { spawnSync } from "node:child_process";
import {
  constants as fsConstants,
  closeSync,
  chmodSync,
  fchownSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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

export interface LinuxAgentIdentity {
  username: string;
  uid: number;
  gid: number;
  home: string;
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

export interface LinuxAgentProvisionOptions {
  agentId: string;
  homeRoot: string;
  onProgress?: (stage: AgentProvisionStage) => void;
}

export type AgentProvisionRunner = (
  agentId: string,
  onProgress: (stage: AgentProvisionStage) => void,
) => Promise<LinuxAgentIdentity>;

const initialMemory =
  "# Agent memory\n\nThis file is the entry point to your private memory and workspace notes.\n";
const activeProvisioning = new Map<string, Promise<LinuxAgentIdentity>>();

/** A deterministic, bounded Linux account name derived from a stable Agent UUID. */
export function linuxUsernameForAgentId(agentId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId))
    throw new Error("Agent identity must be a UUID");
  return `mate_${agentId.replaceAll("-", "").slice(0, 27)}`;
}

/** Create or re-verify an Agent's actual unprivileged Linux account and private home. */
export async function provisionLinuxAgent(
  options: LinuxAgentProvisionOptions,
): Promise<LinuxAgentIdentity> {
  const key = `${resolve(options.homeRoot)}\0${options.agentId.toLowerCase()}`;
  const running = activeProvisioning.get(key);
  if (running) return running;
  const operation = Promise.resolve()
    .then(() => provisionLinuxAgentOnce(options))
    .finally(() => {
      if (activeProvisioning.get(key) === operation) activeProvisioning.delete(key);
    });
  activeProvisioning.set(key, operation);
  return operation;
}

/** Read and verify an existing Agent account without creating or repairing anything. */
export function readProvisionedLinuxAgentIdentity(
  agentId: string,
  homeRoot: string,
): LinuxAgentIdentity {
  if (process.platform !== "linux")
    throw new AgentProvisioningError("unsupported_host", "Agent 身份只能在 Linux 节点上使用。");
  if (!isAbsolute(homeRoot))
    throw new AgentProvisioningError("filesystem_error", "Agent 私人目录根路径必须是绝对路径。");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId))
    throw new AgentProvisioningError("identity_mismatch", "Agent ID 格式无效。");

  const id = agentId.toLowerCase(),
    username = linuxUsernameForAgentId(id),
    root = resolve(homeRoot),
    home = join(root, id);
  verifyHomeRoot(root);
  const account = readPasswd(username),
    group = readGroup(username);
  if (!account) throw new AgentProvisioningError("identity_mismatch", "Agent Linux 账号不存在。");
  verifyAccount(account, group, username, id, home);
  verifyPrivateHome(home, account.uid, account.gid);
  return { username, uid: account.uid, gid: account.gid, home };
}

async function provisionLinuxAgentOnce(
  options: LinuxAgentProvisionOptions,
): Promise<LinuxAgentIdentity> {
  if (process.platform !== "linux")
    throw new AgentProvisioningError("unsupported_host", "Agent 身份只能在 Linux 节点上创建。");
  if (typeof process.geteuid !== "function" || process.geteuid() !== 0)
    throw new AgentProvisioningError(
      "permission_denied",
      "节点服务需要 root 权限才能建立 Agent Linux 账号。",
    );
  if (!isAbsolute(options.homeRoot))
    throw new AgentProvisioningError("filesystem_error", "Agent 私人目录根路径必须是绝对路径。");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.agentId))
    throw new AgentProvisioningError("identity_mismatch", "Agent ID 格式无效。");

  const agentId = options.agentId.toLowerCase(),
    username = linuxUsernameForAgentId(agentId),
    homeRoot = resolve(options.homeRoot),
    home = join(homeRoot, agentId);
  const progress = (stage: AgentProvisionStage) => options.onProgress?.(stage);

  progress("checking_account");
  const existingAccount = readPasswd(username);
  if (!existingAccount) {
    if (readGroup(username))
      throw new AgentProvisioningError("account_conflict", "为 Agent 保留的 Linux 组名已被占用。");
    if (pathExists(home))
      throw new AgentProvisioningError("account_conflict", "Agent home 路径已存在，不能复用。");
    ensureHomeRoot(homeRoot);
    progress("creating_account");
    createAccount(username, agentId, home);
  }

  progress("preparing_home");
  ensureHomeRoot(homeRoot);
  const account = readPasswd(username);
  if (!account)
    throw new AgentProvisioningError("identity_mismatch", "节点未能读取刚创建的 Linux 账号。");
  const group = readGroup(username);
  verifyAccount(account, group, username, agentId, home);
  ensurePrivateHome(home, account.uid, account.gid);
  ensureMemoryEntry(home, account.uid, account.gid);

  progress("verifying_identity");
  const verifiedAccount = readPasswd(username),
    verifiedGroup = readGroup(username);
  if (!verifiedAccount) throw identityMismatch();
  verifyAccount(verifiedAccount, verifiedGroup, username, agentId, home);
  verifyPrivateHome(home, verifiedAccount.uid, verifiedAccount.gid);
  verifyMemoryEntry(home, verifiedAccount.uid, verifiedAccount.gid);
  return { username, uid: verifiedAccount.uid, gid: verifiedAccount.gid, home };
}

/** Turn one authenticated node request into progress and one bounded result message. */
export async function handleAgentProvisionRequest(
  request: Extract<NodeControlMessage, { type: "control.agent.provision" }>,
  send: (message: NodeRequest) => void,
  provision: AgentProvisionRunner,
): Promise<boolean> {
  try {
    const identity = await provision(request.agentId, (stage) => {
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
            "Linux 节点无法完成 Agent 账号与 home 核验，请检查节点状态后重试。",
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

function createAccount(username: string, agentId: string, home: string): void {
  const result = spawnSync(
    "/usr/sbin/useradd",
    [
      "--system",
      "--user-group",
      "--no-create-home",
      "--home-dir",
      home,
      "--shell",
      "/usr/sbin/nologin",
      "--comment",
      `Mate Agent ${agentId}`,
      "--",
      username,
    ],
    { encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" } },
  );
  if (result.error || result.status !== 0) {
    const after = readPasswd(username);
    if (after?.gecos === `Mate Agent ${agentId}` && after.home === home) return;
    if (after)
      throw new AgentProvisioningError("account_conflict", "Linux 用户名已被其他账号占用。");
    throw new AgentProvisioningError("permission_denied", "节点未能创建 Agent Linux 账号。");
  }
}

function ensureHomeRoot(path: string): void {
  const absolute = resolve(path),
    parts = absolute.split("/").filter(Boolean);
  if (parts.length === 0)
    throw new AgentProvisioningError("filesystem_error", "Agent 私人目录根路径不能是系统根目录。");
  let current = "/";
  for (const part of parts) {
    current = join(current, part);
    try {
      mkdirSync(current, { mode: 0o755 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new AgentProvisioningError("filesystem_error", "节点无法准备 Agent 私人目录根路径。");
    }
    const stat = lstatSafe(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0)
      throw new AgentProvisioningError(
        "identity_mismatch",
        "Agent 私人目录根路径必须由 root 管理。",
      );
    const writableByOthers = (stat.mode & 0o022) !== 0,
      stickyRootDirectory = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (writableByOthers && (!stickyRootDirectory || current === absolute))
      throw new AgentProvisioningError(
        "identity_mismatch",
        "Agent 私人目录路径不能允许其他用户写入。",
      );
  }
  try {
    chmodSync(absolute, 0o755);
  } catch {
    throw new AgentProvisioningError("permission_denied", "节点无法保护 Agent 私人目录根路径。");
  }
}

function verifyHomeRoot(path: string): void {
  if (path === "/")
    throw new AgentProvisioningError("filesystem_error", "Agent 私人目录根路径不能是系统根目录。");
  let current = "/";
  for (const part of path.split("/").filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSafe(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0)
      throw new AgentProvisioningError(
        "identity_mismatch",
        "Agent 私人目录根路径必须由 root 管理。",
      );
    const writableByOthers = (stat.mode & 0o022) !== 0,
      stickyRootDirectory = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (writableByOthers && (!stickyRootDirectory || current === path))
      throw new AgentProvisioningError(
        "identity_mismatch",
        "Agent 私人目录路径不能允许其他用户写入。",
      );
  }
}

function verifyAccount(
  account: PasswdEntry,
  group: GroupEntry | undefined,
  username: string,
  agentId: string,
  home: string,
): void {
  if (
    account.name !== username ||
    account.gecos !== `Mate Agent ${agentId}` ||
    account.home !== home ||
    account.shell !== "/usr/sbin/nologin" ||
    account.uid <= 0 ||
    account.gid <= 0 ||
    !group ||
    group.name !== username ||
    group.gid !== account.gid
  )
    throw identityMismatch();
  const passwdEntries = readAllPasswd(),
    groupEntries = readAllGroups(),
    uidRecords = passwdEntries.filter((entry) => entry.uid === account.uid),
    usernameRecords = passwdEntries.filter((entry) => entry.name === username),
    gidRecords = groupEntries.filter((entry) => entry.gid === account.gid),
    groupNameRecords = groupEntries.filter((entry) => entry.name === username);
  if (
    uidRecords.length !== 1 ||
    uidRecords[0]?.name !== username ||
    usernameRecords.length !== 1 ||
    gidRecords.length !== 1 ||
    gidRecords[0]?.name !== username ||
    groupNameRecords.length !== 1
  )
    throw new AgentProvisioningError(
      "identity_mismatch",
      "Agent Linux UID 或 GID 与其他本地账号冲突，不能安全隔离。",
    );
  const supplementary = runRequired("/usr/bin/id", ["-G", username])
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
  if (supplementary.length !== 1 || supplementary[0] !== account.gid)
    throw new AgentProvisioningError(
      "identity_mismatch",
      "Agent Linux 账号具有未授权的附加组，不能复用。",
    );
}

function ensurePrivateHome(path: string, uid: number, gid: number): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
      throw new AgentProvisioningError("filesystem_error", "节点无法创建 Agent 私人 home。");
  }
  const stat = lstatSafe(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new AgentProvisioningError("identity_mismatch", "Agent home 必须是真实目录。");
  const fd = openDirectory(path);
  try {
    const opened = fstatSync(fd);
    if (opened.uid === 0 && opened.gid === 0 && readdirSync(path).length === 0) {
      try {
        fchownSync(fd, uid, gid);
      } catch {
        throw new AgentProvisioningError("permission_denied", "节点无法设置 Agent home 所有者。");
      }
    } else if (opened.uid !== uid || opened.gid !== gid) {
      throw new AgentProvisioningError("identity_mismatch", "Agent home 已属于不同 Linux 身份。");
    }
    fchmodSync(fd, 0o700);
  } catch (error) {
    if (error instanceof AgentProvisioningError) throw error;
    throw new AgentProvisioningError("permission_denied", "节点无法保护 Agent home 权限。");
  } finally {
    closeSync(fd);
  }
}

function ensureMemoryEntry(home: string, uid: number, gid: number): void {
  const path = join(home, "MEMORY.md");
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, initialMemory, "utf8");
    fsyncSync(fd);
    fchownSync(fd, uid, gid);
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
    const template = Buffer.from(initialMemory);
    const interruptedCreate =
      stat.uid === 0 &&
      stat.gid === 0 &&
      contents.length <= template.length &&
      template.subarray(0, contents.length).equals(contents);
    if (stat.uid !== uid || stat.gid !== gid) {
      if (!interruptedCreate)
        throw new AgentProvisioningError("identity_mismatch", "MEMORY.md 已属于不同 Linux 身份。");
    }
    if (interruptedCreate && contents.length < template.length) {
      try {
        rewriteInitialMemory(existingFd, template);
      } catch {
        throw new AgentProvisioningError("filesystem_error", "节点无法恢复 Agent 的 MEMORY.md。");
      }
    }
    if (stat.uid !== uid || stat.gid !== gid) {
      try {
        fchownSync(existingFd, uid, gid);
      } catch {
        throw new AgentProvisioningError("permission_denied", "节点无法设置 MEMORY.md 所有者。");
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

function verifyPrivateHome(path: string, uid: number, gid: number): void {
  const stat = lstatSafe(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    stat.gid !== gid ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new AgentProvisioningError("identity_mismatch", "Agent home 的所有者或权限核验失败。");
}

function verifyMemoryEntry(home: string, uid: number, gid: number): void {
  const fd = openSync(join(home, "MEMORY.md"), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o777) !== 0o600)
      throw new AgentProvisioningError("identity_mismatch", "MEMORY.md 的所有者或权限核验失败。");
  } finally {
    closeSync(fd);
  }
}

function openDirectory(path: string): number {
  try {
    return openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new AgentProvisioningError("identity_mismatch", "Agent home 必须是真实目录。");
  }
}

interface PasswdEntry {
  name: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
}
interface GroupEntry {
  name: string;
  gid: number;
}

function readPasswd(username: string): PasswdEntry | undefined {
  const result = spawnSync("/usr/bin/getent", ["-s", "files", "passwd", username], {
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.status === 2 && !result.error) return undefined;
  if (result.error || result.status !== 0)
    throw new AgentProvisioningError("filesystem_error", "节点无法检查 Linux passwd 账号。");
  const parts = result.stdout.trimEnd().split(":");
  if (parts.length !== 7) throw identityMismatch();
  const uid = Number(parts[2]),
    gid = Number(parts[3]);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) throw identityMismatch();
  return { name: parts[0]!, uid, gid, gecos: parts[4]!, home: parts[5]!, shell: parts[6]! };
}

function readGroup(username: string): GroupEntry | undefined {
  const result = spawnSync("/usr/bin/getent", ["-s", "files", "group", username], {
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.status === 2 && !result.error) return undefined;
  if (result.error || result.status !== 0)
    throw new AgentProvisioningError("filesystem_error", "节点无法检查 Linux group 账号。");
  const parts = result.stdout.trimEnd().split(":");
  if (parts.length !== 4) throw identityMismatch();
  const gid = Number(parts[2]);
  if (!Number.isSafeInteger(gid)) throw identityMismatch();
  return { name: parts[0]!, gid };
}

function readAllPasswd(): PasswdEntry[] {
  const result = spawnSync("/usr/bin/getent", ["-s", "files", "passwd"], {
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.error || result.status !== 0)
    throw new AgentProvisioningError("filesystem_error", "节点无法检查本地 Linux 用户 ID。");
  return result.stdout
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(":");
      if (parts.length !== 7) throw identityMismatch();
      const uid = Number(parts[2]),
        gid = Number(parts[3]);
      if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid)) throw identityMismatch();
      return {
        name: parts[0]!,
        uid,
        gid,
        gecos: parts[4]!,
        home: parts[5]!,
        shell: parts[6]!,
      };
    });
}

function readAllGroups(): GroupEntry[] {
  const result = spawnSync("/usr/bin/getent", ["-s", "files", "group"], {
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.error || result.status !== 0)
    throw new AgentProvisioningError("filesystem_error", "节点无法检查本地 Linux 组 ID。");
  return result.stdout
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(":");
      if (parts.length !== 4) throw identityMismatch();
      const gid = Number(parts[2]);
      if (!Number.isSafeInteger(gid)) throw identityMismatch();
      return { name: parts[0]!, gid };
    });
}

function runRequired(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.error || result.status !== 0)
    throw new AgentProvisioningError("filesystem_error", "节点无法检查 Agent Linux 账号组。");
  return result.stdout;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new AgentProvisioningError("filesystem_error", "节点无法检查 Agent home 路径。");
  }
}

function lstatSafe(path: string) {
  try {
    return lstatSync(path);
  } catch {
    throw new AgentProvisioningError("filesystem_error", "节点无法检查 Agent 私人目录。");
  }
}

function identityMismatch(): AgentProvisioningError {
  return new AgentProvisioningError("identity_mismatch", "Linux 账号资料与 Agent ID 不匹配。");
}
