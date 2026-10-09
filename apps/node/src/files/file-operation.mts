import { systemErrorCode } from "../system-error.js";
import { FileOperationError, fileFailure } from "./file-failures.js";
import { FixedWorkspacePaths } from "./fixed-workspace-paths.js";
// Fixed file helper launched under Mate's existing account. Requests use stdin.
import { workspaceOperationSchema } from "@mate/protocol";
import type { WorkspaceVersion } from "@mate/protocol/workspace";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
  type Stats,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAtomicNoReplaceRename } from "./mutations/atomic-rename.js";
import { commitFileIfHashMatches, moveFileNoReplace } from "./mutations/workspace.js";
const renameNoReplace = createAtomicNoReplaceRename(
  fileURLToPath(new URL("./rename-noreplace", import.meta.url)),
);
process.on("uncaughtException", (error) => {
  process.stderr.write(JSON.stringify(fileFailure(error)));
  process.exitCode = 1;
});

const root = resolve(process.argv[2]!);
if (!lstatSync(root).isDirectory()) throw new Error("Workspace root must be a directory");
const privateMode = process.argv[3] !== "022";
process.umask(privateMode ? 0o077 : 0o022);
const paths = new FixedWorkspacePaths(root, privateMode);
const operation = workspaceOperationSchema.parse(JSON.parse(readFileSync(0, "utf8")));
paths.lockMutation(operation.kind);

const maxTextFileBytes = 1_000_000;
const maxFileHistoryEntries = 5;
function readFileContent(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new FileOperationError("not_file", "Regular single-link file required");
    const buffer = Buffer.alloc(maxTextFileBytes + 1);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead > maxTextFileBytes) throw new Error("File exceeds 1 MB limit");
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const writeJsonResult = (value: unknown) => process.stdout.write(JSON.stringify(value));
function saveFile({
  path,
  value,
  workspacePath,
  expectedCurrentHash,
}: {
  path: string;
  value: string | Buffer;
  workspacePath: string;
  expectedCurrentHash?: string;
}) {
  if (Buffer.byteLength(value) > maxTextFileBytes) throw new Error("File exceeds 1 MB limit");
  if (!paths.pinnedDirectoryPaths) mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    let existing = false;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink())
        throw new FileOperationError("unsafe_path", "unsafe_path: Symbolic links are not followed");
      existing = true;
    } catch (error) {
      if (systemErrorCode(error) !== "ENOENT") throw error;
    }
    if (existing) {
      const previousContent = readFileContent(path);
      const history = paths.checked(`${workspacePath}.history`, { allowMissing: true });
      try {
        mkdirSync(history, { mode: 0o700 });
      } catch (error) {
        if (systemErrorCode(error) !== "EEXIST") throw error;
      }
      const historyFile = paths.checked(`${workspacePath}.history/${Date.now()}-${randomUUID()}`, {
        allowMissing: true,
      });
      try {
        writeFileSync(historyFile, previousContent, { flag: "wx", mode: 0o600 });
      } finally {
        paths.releasePinned(historyFile);
      }
      for (const oldName of paths.directoryNames(history).sort().slice(0, -maxFileHistoryEntries)) {
        const oldPath = paths.checked(`${workspacePath}.history/${oldName}`);
        try {
          unlinkSync(oldPath);
        } finally {
          paths.releasePinned(oldPath);
        }
      }
      paths.releasePinned(history);
    }
    writeFileSync(temp, value, { flag: "wx", mode: privateMode ? 0o600 : 0o644 });
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (expectedCurrentHash) {
      commitFileIfHashMatches(
        expectedCurrentHash,
        () => readFileContent(path),
        () => renameSync(temp, path),
      );
    } else renameSync(temp, path);
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
    writeJsonResult({ sha256: sha256(value) });
  } finally {
    try {
      unlinkSync(temp);
    } catch {}
  }
}
const path = paths.checked(operation.path, {
  allowMissing:
    operation.kind === "write" || operation.kind === "write_bytes" || operation.kind === "mkdir",
  createParents:
    operation.kind === "write" || operation.kind === "write_bytes" || operation.kind === "mkdir",
});
switch (operation.kind) {
  case "read_bytes": {
    const value = readFileContent(path);
    writeJsonResult({
      base64: value
        .subarray(operation.offset, operation.offset + operation.length)
        .toString("base64"),
      offset: operation.offset,
      totalBytes: value.length,
      sha256: sha256(value),
    });
    break;
  }
  case "write_bytes": {
    const value = Buffer.from(operation.base64, "base64");
    if (value.toString("base64") !== operation.base64) throw new Error("Invalid base64");
    saveFile({ path, value, workspacePath: operation.path });
    break;
  }
  case "read": {
    const value = readFileContent(path);
    if (value.length > 8192) throw new Error("File exceeds read limit; use workspace.read_chunk");
    process.stdout.write(value);
    break;
  }
  case "write":
    saveFile({ path, value: operation.content, workspacePath: operation.path });
    break;
  case "edit": {
    const value = readFileContent(path);
    if (sha256(value) !== operation.expectedHash)
      throw new FileOperationError("file_changed", "File changed");
    const text = value.toString("utf8");
    const first = text.indexOf(operation.oldText);
    if (first < 0 || text.indexOf(operation.oldText, first + operation.oldText.length) >= 0)
      throw new Error("Edit must match exactly once");
    saveFile({
      path,
      value:
        text.slice(0, first) + operation.newText + text.slice(first + operation.oldText.length),
      workspacePath: operation.path,
      expectedCurrentHash: operation.expectedHash,
    });
    break;
  }
  case "stat": {
    const stat = lstatSync(path);
    writeJsonResult({
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      size: stat.size,
      sha256: stat.isFile() && stat.size <= maxTextFileBytes ? sha256(readFileContent(path)) : null,
    });
    break;
  }
  case "workspace_list": {
    const names = paths.directoryNames(path).sort();
    const page = names.slice(operation.offset, operation.offset + operation.limit);
    const entries = page.map((name) => {
      const stat = lstatSync(resolve(path, name));
      return {
        name,
        type: listedFileType(stat),
        size: stat.size,
      };
    });
    writeJsonResult({
      path: operation.path,
      entries,
      nextOffset:
        operation.offset + page.length < names.length ? operation.offset + page.length : null,
    });
    break;
  }
  case "workspace_stat": {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
      throw new FileOperationError("unsafe_path", "unsafe_path: Symbolic links are not followed");
    if (stat.isDirectory()) {
      writeJsonResult({ type: "directory", size: stat.size, modifiedAt: stat.mtimeMs });
      break;
    }
    if (!stat.isFile() || stat.nlink !== 1)
      throw new FileOperationError(
        "not_file",
        "not_regular_file: A regular single-link file is required",
      );
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.ino !== BigInt(stat.ino))
        throw new FileOperationError(
          "file_changed",
          "file_changed: File changed while it was being inspected",
        );
      writeJsonResult({
        type: "file",
        size: Number(opened.size),
        modifiedAt: Number(opened.mtimeNs) / 1_000_000,
        version: versionOf(opened),
      });
    } finally {
      closeSync(fd);
    }
    break;
  }
  case "workspace_read_chunk": {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n)
        throw new FileOperationError(
          "not_file",
          "not_regular_file: A regular single-link file is required",
        );
      const version = versionOf(before);
      if (operation.version && !sameVersion(version, operation.version))
        throw new FileOperationError(
          "file_changed",
          "file_changed: File changed while it was being read",
        );
      const bytes = Number(before.size);
      if (!Number.isSafeInteger(bytes)) throw new Error("file_too_large: File size is unsupported");
      const chunk = Buffer.alloc(Math.min(operation.length, Math.max(0, bytes - operation.offset)));
      let count = 0;
      while (count < chunk.length) {
        const read = readSync(fd, chunk, count, chunk.length - count, operation.offset + count);
        if (!read) break;
        count += read;
      }
      const after = fstatSync(fd, { bigint: true });
      if (!sameVersion(version, versionOf(after)))
        throw new FileOperationError(
          "file_changed",
          "file_changed: File changed while it was being read",
        );
      writeJsonResult({
        base64: chunk.subarray(0, count).toString("base64"),
        offset: operation.offset,
        totalBytes: bytes,
        version,
      });
    } finally {
      closeSync(fd);
    }
    break;
  }
  case "list": {
    const entries: unknown[] = [];
    let truncated = false;
    let bytes = 0;
    for (const name of paths.directoryNames(path).sort()) {
      const stat = lstatSync(resolve(path, name));
      const entry = {
        name,
        type: listedFileType(stat),
        size: stat.size,
      };
      bytes += Buffer.byteLength(JSON.stringify(entry));
      if (entries.length >= 200 || bytes > 48000) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
    writeJsonResult({ entries, truncated });
    break;
  }
  case "search": {
    const query = operation.query;
    const matches: unknown[] = [];
    let visited = 0;
    let bytes = 0;
    let truncated = false;
    function visit(relativePath: string, file: string) {
      if (++visited > 1000) {
        truncated = true;
        return;
      }
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        for (const name of paths.directoryNames(file).sort()) {
          if (visited >= 1000 || matches.length >= 100 || bytes >= 45000) {
            truncated = true;
            break;
          }
          const childRelativePath =
            !relativePath || relativePath === "." ? name : `${relativePath}/${name}`;
          const childPath = paths.checked(childRelativePath);
          try {
            visit(childRelativePath, childPath);
          } catch (error) {
            const code = systemErrorCode(error);
            if (
              code !== "ENOENT" &&
              code !== "ENOTDIR" &&
              !(error instanceof FileOperationError && error.errorCode === "unsafe_path")
            )
              throw error;
          } finally {
            paths.releasePinned(childPath);
          }
        }
        return;
      }
      if (!stat.isFile()) return;
      if (stat.size > maxTextFileBytes) {
        truncated = true;
        return;
      }
      let data: Buffer;
      try {
        data = readFileContent(file);
      } catch (error) {
        if (["ELOOP", "ENOENT", "ENOTDIR"].includes(systemErrorCode(error) ?? "")) return;
        throw error;
      }
      if (data.includes(0)) return;
      for (const [index, line] of data.toString("utf8").split("\n").entries())
        if (line.includes(query)) {
          const item = {
            path: resolve(root, relativePath || "."),
            line: index + 1,
            text: line.slice(0, 1000),
            truncated: line.length > 1000,
          };
          bytes += Buffer.byteLength(JSON.stringify(item));
          if (matches.length >= 100 || bytes >= 45000) {
            truncated = true;
            break;
          }
          matches.push(item);
        }
    }
    visit(operation.path, path);
    writeJsonResult({ matches, visited, truncated });
    break;
  }
  case "mkdir":
    mkdirSync(path, { recursive: true, mode: privateMode ? 0o700 : 0o755 });
    writeJsonResult({ created: operation.path });
    break;
  case "move": {
    const destination = paths.checked(operation.destination, { allowMissing: true });
    moveFileNoReplace(path, destination, renameNoReplace);
    for (const directory of new Set([dirname(path), dirname(destination)])) {
      const fd = openSync(directory, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    writeJsonResult({ moved: operation.path, destination: operation.destination });
    break;
  }
  case "remove": {
    const stat = lstatSync(path);
    if (
      operation.expectedHash &&
      (!stat.isFile() || sha256(readFileContent(path)) !== operation.expectedHash)
    )
      throw new FileOperationError("file_changed", "File changed");
    // Nonempty directories require explicit child removals (or an authorized exec).
    if (stat.isDirectory()) rmdirSync(path);
    else if (stat.isFile()) unlinkSync(path);
    else throw new Error("Regular file or empty directory required");
    writeJsonResult({ removed: operation.path });
    break;
  }
}

function listedFileType(stat: Pick<Stats, "isSymbolicLink" | "isDirectory" | "isFile">) {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

function versionOf(
  stat: Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">,
): WorkspaceVersion {
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size)) throw new Error("file_too_large: File size is unsupported");
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size,
    modifiedNs: stat.mtimeNs.toString(),
    changedNs: stat.ctimeNs.toString(),
  };
}

function sameVersion(left: WorkspaceVersion, right: WorkspaceVersion): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs
  );
}
