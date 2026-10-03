import { FileOperationError, fileFailure } from "./file-failures.js";
import { systemErrorCode } from "../system-error.js";
// Fixed file helper launched under Mate's existing account. Requests use stdin.
import {
  constants,
  openSync,
  readSync,
  readFileSync,
  closeSync,
  existsSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  lstatSync,
  unlinkSync,
  readdirSync,
  fsyncSync,
  rmdirSync,
  fstatSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { within } from "./path-resolution.js";
import { createAtomicNoReplaceRename } from "./atomic-rename.js";
import { commitFileIfHashMatches, moveFileNoReplace } from "./workspace-mutations.js";
import { operationSchema, type Operation } from "@mate/protocol";
import type { WorkspaceVersion } from "@mate/protocol/workspace";
// The CommonJS native binding is loaded only on Linux; its signature comes from @types/fs-ext.
type FlockSync = typeof import("fs-ext").flockSync;
const flockSync: FlockSync | undefined =
  process.platform === "linux"
    ? (createRequire(import.meta.url)("fs-ext").flockSync as FlockSync)
    : undefined;
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
const pinnedDirectoryPaths = process.platform === "linux" && existsSync("/proc/self/fd"),
  rootDescriptor = pinnedDirectoryPaths
    ? openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    : undefined,
  pinnedDescriptors = new Set<number>();
if (rootDescriptor !== undefined) {
  const rootStat = fstatSync(rootDescriptor),
    pathStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.dev !== pathStat.dev || rootStat.ino !== pathStat.ino)
    throw new FileOperationError(
      "unsafe_path",
      "unsafe_path: Workspace root changed while it was opened",
    );
}
const operation = operationSchema.parse(JSON.parse(readFileSync(0, "utf8")));
const mutatingKinds = new Set<Operation["kind"]>([
  "write_bytes",
  "write",
  "edit",
  "mkdir",
  "move",
  "remove",
]);
// This lock serializes short Mate workspace mutations only; ordinary Agent shell commands do not
// acquire it, so a long-lived command or background process cannot hold up this operation.
if (
  pinnedDirectoryPaths &&
  rootDescriptor !== undefined &&
  flockSync !== undefined &&
  mutatingKinds.has(operation.kind)
)
  flockSync(rootDescriptor, "ex");
function checked(path: string, allowMissing = false, createParents = false): string {
  let workspacePath = path;
  if (isAbsolute(workspacePath)) {
    if (workspacePath === root) workspacePath = ".";
    else if (workspacePath.startsWith(`${root}/`))
      workspacePath = workspacePath.slice(root.length + 1);
    else throw new FileOperationError("unsafe_path", "unsafe_path: Path escapes the workspace");
  }
  if (workspacePath.includes("\0"))
    throw new FileOperationError("unsafe_path", "unsafe_path: Invalid workspace path");
  const parts = workspacePath.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === ".."))
    throw new FileOperationError("unsafe_path", "unsafe_path: Path escapes the workspace");
  if (pinnedDirectoryPaths && rootDescriptor !== undefined) {
    if (parts.length === 0) return `${descriptorPath(rootDescriptor)}/.`;
    let parent = rootDescriptor,
      ownedParent = false;
    try {
      for (const part of parts.slice(0, -1)) {
        const candidate = `${descriptorPath(parent)}/${part}`;
        let child: number;
        try {
          child = openSync(
            candidate,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
        } catch (error) {
          if (!createParents || systemErrorCode(error) !== "ENOENT") throw error;
          try {
            mkdirSync(candidate, { mode: privateMode ? 0o700 : 0o755 });
          } catch (mkdirError) {
            if (systemErrorCode(mkdirError) !== "EEXIST") throw mkdirError;
          }
          child = openSync(
            candidate,
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
        }
        if (ownedParent) closeSync(parent);
        parent = child;
        ownedParent = true;
      }
      const target = `${descriptorPath(parent)}/${parts.at(-1)!}`;
      try {
        if (lstatSync(target).isSymbolicLink())
          throw new FileOperationError(
            "unsafe_path",
            "unsafe_path: Symbolic links are not followed in the workspace",
          );
      } catch (error) {
        if (systemErrorCode(error) !== "ENOENT" || !allowMissing) throw error;
      }
      if (ownedParent) pinnedDescriptors.add(parent);
      return target;
    } catch (error) {
      if (ownedParent) closeSync(parent);
      throw error;
    }
  }
  let target = root,
    missing = false;
  for (const part of parts) {
    target = resolve(target, part);
    if (!within(root, target))
      throw new FileOperationError("unsafe_path", "unsafe_path: Path escapes the workspace");
    if (missing) continue;
    try {
      if (lstatSync(target).isSymbolicLink())
        throw new FileOperationError(
          "unsafe_path",
          "unsafe_path: Symbolic links are not followed in the workspace",
        );
    } catch (error) {
      if (systemErrorCode(error) === "ENOENT" && allowMissing) missing = true;
      else throw error;
    }
  }
  return target;
}
function descriptorPath(descriptor: number): string {
  return `/proc/self/fd/${descriptor}`;
}
function releasePinned(path: string): void {
  if (!pinnedDirectoryPaths || rootDescriptor === undefined) return;
  const match = path.match(/^\/proc\/self\/fd\/(\d+)(?:\/|$)/),
    descriptor = match ? Number(match[1]) : undefined;
  if (
    descriptor !== undefined &&
    descriptor !== rootDescriptor &&
    pinnedDescriptors.delete(descriptor)
  )
    closeSync(descriptor);
}
function directoryNames(path: string): string[] {
  if (!pinnedDirectoryPaths) return readdirSync(path);
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new FileOperationError(
      "unsafe_path",
      "unsafe_path: A real workspace directory is required",
    );
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new FileOperationError(
        "unsafe_path",
        "unsafe_path: Workspace directory changed while it was opened",
      );
    return readdirSync(descriptorPath(descriptor));
  } finally {
    closeSync(descriptor);
  }
}
function content(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new FileOperationError("not_file", "Regular single-link file required");
    const buf = Buffer.alloc(1000001),
      n = readSync(fd, buf, 0, buf.length, 0);
    if (n > 1000000) throw new Error("File exceeds 1 MB limit");
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const json = (value: unknown) => process.stdout.write(JSON.stringify(value));
function save(
  path: string,
  value: string | Buffer,
  workspacePath: string,
  expectedCurrentHash?: string,
) {
  if (Buffer.byteLength(value) > 1000000) throw new Error("File exceeds 1 MB limit");
  if (!pinnedDirectoryPaths) mkdirSync(dirname(path), { recursive: true });
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
      const old = content(path),
        history = checked(`${workspacePath}.history`, true);
      try {
        mkdirSync(history, { mode: 0o700 });
      } catch (error) {
        if (systemErrorCode(error) !== "EEXIST") throw error;
      }
      const historyFile = checked(`${workspacePath}.history/${Date.now()}-${randomUUID()}`, true);
      try {
        writeFileSync(historyFile, old, { flag: "wx", mode: 0o600 });
      } finally {
        releasePinned(historyFile);
      }
      for (const oldName of directoryNames(history).sort().slice(0, -5)) {
        const oldPath = checked(`${workspacePath}.history/${oldName}`);
        try {
          unlinkSync(oldPath);
        } finally {
          releasePinned(oldPath);
        }
      }
      releasePinned(history);
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
        () => content(path),
        () => renameSync(temp, path),
      );
    } else renameSync(temp, path);
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
    json({ sha256: hash(value) });
  } finally {
    try {
      unlinkSync(temp);
    } catch {}
  }
}
const path = checked(
  operation.path,
  operation.kind === "write" || operation.kind === "write_bytes" || operation.kind === "mkdir",
  operation.kind === "write" || operation.kind === "write_bytes" || operation.kind === "mkdir",
);
switch (operation.kind) {
  case "read_bytes": {
    const value = content(path);
    json({
      base64: value
        .subarray(operation.offset, operation.offset + operation.length)
        .toString("base64"),
      offset: operation.offset,
      totalBytes: value.length,
      sha256: hash(value),
    });
    break;
  }
  case "write_bytes": {
    const value = Buffer.from(operation.base64, "base64");
    if (value.toString("base64") !== operation.base64) throw new Error("Invalid base64");
    save(path, value, operation.path);
    break;
  }
  case "read": {
    const value = content(path);
    if (value.length > 8192) throw new Error("File exceeds read limit; use workspace.read_chunk");
    process.stdout.write(value);
    break;
  }
  case "write":
    save(path, operation.content, operation.path);
    break;
  case "edit": {
    const value = content(path);
    if (hash(value) !== operation.expectedHash)
      throw new FileOperationError("file_changed", "File changed");
    const text = value.toString("utf8"),
      first = text.indexOf(operation.oldText);
    if (first < 0 || text.indexOf(operation.oldText, first + operation.oldText.length) >= 0)
      throw new Error("Edit must match exactly once");
    save(
      path,
      text.slice(0, first) + operation.newText + text.slice(first + operation.oldText.length),
      operation.path,
      operation.expectedHash,
    );
    break;
  }
  case "stat": {
    const stat = lstatSync(path);
    json({
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      size: stat.size,
      sha256: stat.isFile() && stat.size <= 1000000 ? hash(content(path)) : null,
    });
    break;
  }
  case "workspace_list": {
    const names = directoryNames(path).sort(),
      page = names.slice(operation.offset, operation.offset + operation.limit),
      entries: Array<{ name: string; type: string; size: number }> = [];
    for (const name of page) {
      const stat = lstatSync(resolve(path, name));
      entries.push({
        name,
        type: stat.isSymbolicLink()
          ? "symlink"
          : stat.isDirectory()
            ? "directory"
            : stat.isFile()
              ? "file"
              : "other",
        size: stat.size,
      });
    }
    json({
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
      json({ type: "directory", size: stat.size, modifiedAt: stat.mtimeMs });
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
      json({
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
      json({
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
    let truncated = false,
      bytes = 0;
    for (const name of directoryNames(path).sort()) {
      const stat = lstatSync(resolve(path, name));
      const entry = {
        name,
        type: stat.isSymbolicLink()
          ? "symlink"
          : stat.isDirectory()
            ? "directory"
            : stat.isFile()
              ? "file"
              : "other",
        size: stat.size,
      };
      bytes += Buffer.byteLength(JSON.stringify(entry));
      if (entries.length >= 200 || bytes > 48000) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
    json({ entries, truncated });
    break;
  }
  case "search": {
    const matches: unknown[] = [];
    let visited = 0,
      bytes = 0,
      truncated = false;
    function visit(relativePath: string, file: string) {
      if (++visited > 1000) {
        truncated = true;
        return;
      }
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        for (const name of directoryNames(file).sort()) {
          if (visited >= 1000 || matches.length >= 100 || bytes >= 45000) {
            truncated = true;
            break;
          }
          const childRelativePath =
            !relativePath || relativePath === "." ? name : `${relativePath}/${name}`;
          const childPath = checked(childRelativePath);
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
            releasePinned(childPath);
          }
        }
        return;
      }
      if (!stat.isFile()) return;
      if (stat.size > 1000000) {
        truncated = true;
        return;
      }
      let data: Buffer;
      try {
        data = content(file);
      } catch (error) {
        if (["ELOOP", "ENOENT", "ENOTDIR"].includes(systemErrorCode(error) ?? "")) return;
        throw error;
      }
      if (data.includes(0)) return;
      for (const [index, line] of data.toString("utf8").split("\n").entries())
        if (line.includes(operation.kind === "search" ? operation.query : "")) {
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
    json({ matches, visited, truncated });
    break;
  }
  case "mkdir":
    mkdirSync(path, { recursive: true, mode: privateMode ? 0o700 : 0o755 });
    json({ created: operation.path });
    break;
  case "move": {
    const destination = checked(operation.destination, true);
    moveFileNoReplace(path, destination, renameNoReplace);
    for (const directory of new Set([dirname(path), dirname(destination)])) {
      const fd = openSync(directory, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    json({ moved: operation.path, destination: operation.destination });
    break;
  }
  case "remove": {
    const stat = lstatSync(path);
    if (
      operation.expectedHash &&
      (!stat.isFile() || hash(content(path)) !== operation.expectedHash)
    )
      throw new FileOperationError("file_changed", "File changed");
    // Nonempty directories require explicit child removals (or an authorized exec).
    if (stat.isDirectory()) rmdirSync(path);
    else if (stat.isFile()) unlinkSync(path);
    else throw new Error("Regular file or empty directory required");
    json({ removed: operation.path });
    break;
  }
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
