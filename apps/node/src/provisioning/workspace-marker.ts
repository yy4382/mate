import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { systemErrorCode } from "../system-error.js";
import { AgentProvisioningError } from "./errors.js";
// The marker is 64 ASCII hex digits followed by one newline.
const workspaceMarkerFileBytes = 65;
const workspaceMarkerName = ".mate-workspace-id";
const workspaceMarkerStagingPattern = /^\.mate-workspace-id\.tmp-[0-9a-f]{32}$/;
export function ensureWorkspaceMarker(workspace: string): void {
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
    if (systemErrorCode(error) !== "ENOENT") throw error;
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
      if (systemErrorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      (stat.size !== 0 && stat.size !== workspaceMarkerFileBytes)
    )
      continue;
    try {
      unlinkSync(staged);
    } catch (error) {
      if (systemErrorCode(error) !== "ENOENT") throw error;
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
      if (systemErrorCode(error) !== "EEXIST") throw error;
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
      if (systemErrorCode(error) !== "ENOENT") throw error;
    }
  }
}

function leftoverStagingFiles(workspace: string): string[] {
  return readdirSync(workspace)
    .filter((name) => workspaceMarkerStagingPattern.test(name))
    .map((name) => join(workspace, name));
}

export function verifyWorkspaceMarker(workspace: string, allowStagedLink = false): string {
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
      stat.size !== workspaceMarkerFileBytes
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
