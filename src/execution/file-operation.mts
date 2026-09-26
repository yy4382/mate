// Fixed file helper launched under the Agent's Linux user. Requests use stdin.
import {
  constants,
  openSync,
  readSync,
  readFileSync,
  closeSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  lstatSync,
  unlinkSync,
  readdirSync,
  fsyncSync,
  rmdirSync,
  fstatSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { within } from "./paths.js";
import type { Operation } from "./backend.js";
const root = resolve(process.argv[2]!);
if (!lstatSync(root).isDirectory()) throw new Error("Workspace root must be a directory");
const privateMode = process.argv[3] !== "022";
process.umask(privateMode ? 0o077 : 0o022);
const operation = JSON.parse(readFileSync(0, "utf8")) as Exclude<Operation, { kind: "exec" }>;
function checked(path: string, allowMissing = false): string {
  if (path.includes("\0") || isAbsolute(path)) throw new Error("unsafe_path: Invalid workspace path");
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error("unsafe_path: Path escapes the workspace");
  let target = root,
    missing = false;
  for (const part of parts) {
    target = resolve(target, part);
    if (!within(root, target)) throw new Error("unsafe_path: Path escapes the workspace");
    if (missing) continue;
    try {
      if (lstatSync(target).isSymbolicLink())
        throw new Error("unsafe_path: Symbolic links are not followed in the workspace");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) missing = true;
      else throw error;
    }
  }
  return target;
}
function content(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Regular single-link file required");
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
function save(path: string, value: string | Buffer) {
  if (Buffer.byteLength(value) > 1000000) throw new Error("File exceeds 1 MB limit");
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    let existing = false;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("unsafe_path: Symbolic links are not followed");
      existing = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      const old = content(path),
        history = checked(`${relative(root, path)}.history`, true);
      mkdirSync(history, { recursive: true });
      writeFileSync(`${history}/${Date.now()}-${randomUUID()}`, old, { flag: "wx", mode: 0o600 });
      for (const oldName of readdirSync(history).sort().slice(0, -5))
        unlinkSync(checked(`${relative(root, history)}/${oldName}`));
    }
    writeFileSync(temp, value, { flag: "wx", mode: privateMode ? 0o600 : 0o644 });
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
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
  operation.kind === "write" ||
    operation.kind === "write_bytes" ||
    operation.kind === "mkdir",
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
    save(path, value);
    break;
  }
  case "read": {
    const value = content(path);
    if (value.length > 65536) throw new Error("File exceeds read limit; use search or exec");
    process.stdout.write(value);
    break;
  }
  case "write":
    save(path, operation.content);
    break;
  case "edit": {
    const value = content(path);
    if (hash(value) !== operation.expectedHash) throw new Error("File changed");
    const text = value.toString("utf8"),
      first = text.indexOf(operation.oldText);
    if (first < 0 || text.indexOf(operation.oldText, first + operation.oldText.length) >= 0)
      throw new Error("Edit must match exactly once");
    save(
      path,
      text.slice(0, first) + operation.newText + text.slice(first + operation.oldText.length),
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
    const names = readdirSync(path).sort(),
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
      nextOffset: operation.offset + page.length < names.length ? operation.offset + page.length : null,
    });
    break;
  }
  case "workspace_stat": {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("unsafe_path: Symbolic links are not followed");
    if (stat.isDirectory()) {
      json({ type: "directory", size: stat.size, modifiedAt: stat.mtimeMs });
      break;
    }
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("not_regular_file: A regular single-link file is required");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.ino !== BigInt(stat.ino))
        throw new Error("file_changed: File changed while it was being inspected");
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
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n)
        throw new Error("not_regular_file: A regular single-link file is required");
      const version = versionOf(before);
      if (operation.version && !sameVersion(version, operation.version))
        throw new Error("file_changed: File changed while it was being read");
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
        throw new Error("file_changed: File changed while it was being read");
      json({ base64: chunk.subarray(0, count).toString("base64"), offset: operation.offset, totalBytes: bytes, version });
    } finally {
      closeSync(fd);
    }
    break;
  }
  case "list": {
    const entries: unknown[] = [];
    let truncated = false,
      bytes = 0;
    for (const name of readdirSync(path).sort()) {
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
    function visit(file: string) {
      if (++visited > 1000) {
        truncated = true;
        return;
      }
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) {
        for (const name of readdirSync(file).sort()) {
          if (visited >= 1000 || matches.length >= 100 || bytes >= 45000) {
            truncated = true;
            break;
          }
          visit(resolve(file, name));
        }
        return;
      }
      if (!stat.isFile()) return;
      if (stat.size > 1000000) {
        truncated = true;
        return;
      }
      const data = content(file);
      if (data.includes(0)) return;
      for (const [index, line] of data.toString("utf8").split("\n").entries())
        if (line.includes(operation.kind === "search" ? operation.query : "")) {
          const item = {
            path: file,
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
    visit(path);
    json({ matches, visited, truncated });
    break;
  }
  case "mkdir":
    mkdirSync(checked(operation.path, true), { recursive: true });
    json({ created: operation.path });
    break;
  case "move": {
    const destination = checked(operation.destination, true);
    try {
      lstatSync(destination);
      throw new Error("Destination exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(path, destination);
    json({ moved: operation.path, destination: operation.destination });
    break;
  }
  case "remove": {
    const stat = lstatSync(path);
    if (
      operation.expectedHash &&
      (!stat.isFile() || hash(content(path)) !== operation.expectedHash)
    )
      throw new Error("File changed");
    // Nonempty directories require explicit child removals (or an authorized exec).
    if (stat.isDirectory()) rmdirSync(path);
    else if (stat.isFile()) unlinkSync(path);
    else throw new Error("Regular file or empty directory required");
    json({ removed: operation.path });
    break;
  }
}

function versionOf(stat: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}) {
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

function sameVersion(
  left: ReturnType<typeof versionOf>,
  right: ReturnType<typeof versionOf>,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs
  );
}
