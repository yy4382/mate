import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  realpathSync,
  chmodSync,
  chownSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  chmod,
  chown,
  lchown,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  statfs,
  symlink,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireLock } from "../storage/lock.js";

/** The host facts every maintenance step observes. */
export interface HostStat {
  dev: number;
  ino: number;
  nlink: number;
  size: number;
  blocks: number;
  mode: number;
  uid: number;
  gid: number;
  mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
/** An open host file pinned by descriptor, so identity checks cannot be redirected by a path swap. */
export interface HostHandle {
  stat(): Promise<HostStat>;
  readFile(): Promise<Buffer>;
  writeFile(data: string | Buffer): Promise<void>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<number>;
  write(buffer: Buffer, offset: number, length: number, position: number): Promise<number>;
  chown(uid: number, gid: number): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface HostCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface HostFilesystem {
  blockSize: number;
  availableBlocks: number;
  freeInodes: number;
}

/**
 * The one replaceable entry for every file, command and process operation the maintenance
 * commands (plan, preflight, install, upgrade, rollback/finalize, disable, doctor,
 * offline-probe, status/logs, backup, restore) perform on the real host.
 *
 * Maintenance callers receive this object as an argument; only the process entry points
 * (`src/main.ts`, `src/deployment/cli.ts`) construct the real one. `run` and the process facts
 * are synchronous one-shot service-manager/kernel queries; file operations are asynchronous.
 */
export interface HostOperations {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly node: string;
  readonly modulesAbi: string;
  euid(): number;
  egid(): number;
  /** Absolute physical path, resolving symlinked ancestors even when the leaf does not exist yet. */
  canonical(path: string): Promise<string>;
  /** Allocated bytes of a directory tree, as reported by the filesystem. */
  directoryBytes(path: string): Promise<number>;
  availableBytes(path: string): Promise<number>;
  filesystem(path: string): Promise<HostFilesystem>;
  memoryMiB(): Promise<number>;
  /** Reject executables an unprivileged Agent could replace. */
  assertRootExecutable(path: string): Promise<void>;
  /** One bounded command; a missing binary is a non-zero result, not an exception. */
  run(binary: string, args: readonly string[], options?: { timeoutMs?: number }): HostCommandResult;
  lstat(path: string): Promise<HostStat>;
  readdir(path: string): Promise<string[]>;
  readText(path: string): Promise<string>;
  readlink(path: string): Promise<string>;
  /** SHA-256 of one regular file. */
  sha256(path: string): Promise<string>;
  openForRead(path: string): Promise<HostHandle>;
  openDirectoryForRead(path: string): Promise<HostHandle>;
  createExclusive(path: string, mode: number): Promise<HostHandle>;
  mkdir(path: string, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  lchown(path: string, uid: number, gid: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  fsyncDirectory(path: string): Promise<void>;
  /** Kernel-owned single-instance lock on a managed state file; returns its release function. */
  lockExclusive(path: string): () => void;
}

/**
 * Whether the running process was started through a known module path. The maintenance
 * process entries need this one path fact at load time; keeping it here is what lets those
 * entries stay free of direct filesystem access.
 */
export const isEntryModule = (argument: string | undefined, moduleUrl: string): boolean =>
  !!argument && moduleUrl === pathToFileURL(realpathSync(resolve(argument))).href;

/** Read a path an operator named on the command line, following a symlinked leaf as before. */
export async function readOperatorText(host: HostOperations, path: string): Promise<string> {
  return host.readText(await host.canonical(path));
}

/** True when the path exists; only a missing path is reported as absent. */
export async function pathExists(host: HostOperations, path: string): Promise<boolean> {
  try {
    await host.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const handle = (value: FileHandle): HostHandle => ({
  stat: () => value.stat(),
  readFile: () => value.readFile(),
  writeFile: (data) => value.writeFile(data),
  read: async (buffer, offset, length, position) =>
    (await value.read(buffer, offset, length, position)).bytesRead,
  write: async (buffer, offset, length, position) =>
    (await value.write(buffer, offset, length, position)).bytesWritten,
  chown: (uid, gid) => value.chown(uid, gid),
  chmod: (mode) => value.chmod(mode),
  sync: () => value.sync(),
  close: () => value.close(),
});

async function readText(path: string): Promise<string> {
  const value = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return (await value.readFile()).toString("utf8");
  } finally {
    await value.close();
  }
}

function command(
  binary: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
): HostCommandResult {
  const result = spawnSync(binary, [...args], {
    encoding: "utf8",
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" },
    maxBuffer: 4 * 1024 * 1024,
    ...(options?.timeoutMs ? { timeout: options.timeoutMs } : {}),
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? String(result.error ?? ""),
  };
}

async function canonical(path: string): Promise<string> {
  const tail: string[] = [];
  let current = resolve(path);
  while (true) {
    try {
      await lstat(current);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error(`Cannot resolve deployment path: ${path}`);
      tail.unshift(basename(current));
      current = parent;
    }
  }
  return resolve(await realpath(current), ...tail);
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  const visit = async (current: string): Promise<void> => {
    const stat = await lstat(current);
    if (stat.isFile()) total += stat.blocks * 512;
    else if (stat.isDirectory())
      for (const name of await readdir(current)) await visit(join(current, name));
  };
  await visit(path);
  return total;
}

/** The only production implementation; constructed by the process entry points. */
export const nodeHostOperations = (): HostOperations => ({
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  modulesAbi: process.versions.modules,
  euid: () => process.geteuid?.() ?? -1,
  egid: () => process.getegid?.() ?? -1,
  canonical,
  directoryBytes,
  availableBytes: async (path) => {
    const stat = await statfs(path);
    return Number(BigInt(stat.bavail) * BigInt(stat.bsize));
  },
  filesystem: async (path) => {
    const stat = await statfs(path);
    return {
      blockSize: Number(stat.bsize),
      availableBlocks: Number(stat.bavail),
      freeInodes: Number(stat.ffree),
    };
  },
  memoryMiB: async () => {
    const match = /^MemTotal:\s+(\d+)\s+kB$/m.exec(await readText("/proc/meminfo"));
    if (!match) throw new Error("Cannot read host memory");
    return Math.floor(Number(match[1]) / 1024);
  },
  assertRootExecutable: async (path) => {
    const link = await lstat(path),
      stat = await lstat(await realpath(path));
    if (
      (!link.isFile() && !link.isSymbolicLink()) ||
      link.uid !== 0 ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 ||
      (stat.mode & 0o111) === 0
    )
      throw new Error(`Host executable is not protected: ${path}`);
  },
  run: command,
  lstat: (path) => lstat(path),
  readdir: (path) => readdir(path),
  readText,
  readlink: (path) => readlink(path),
  sha256: async (path) => {
    const value = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const digest = createHash("sha256"),
        buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await value.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        digest.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      return digest.digest("hex");
    } finally {
      await value.close();
    }
  },
  openForRead: async (path) => handle(await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)),
  openDirectoryForRead: async (path) =>
    handle(await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)),
  createExclusive: async (path, mode) =>
    handle(
      await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        mode,
      ),
    ),
  mkdir: async (path, mode) => {
    await mkdir(path, { mode });
  },
  chmod: (path, mode) => chmod(path, mode),
  chown: (path, uid, gid) => chown(path, uid, gid),
  lchown: (path, uid, gid) => lchown(path, uid, gid),
  rename: (from, to) => rename(from, to),
  remove: async (path, options) => {
    await rm(path, {
      recursive: options?.recursive ?? false,
      force: options?.force ?? true,
    });
  },
  symlink: (target, path) => symlink(target, path),
  unlink: (path) => unlink(path),
  fsyncDirectory: async (path) => {
    const value = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await value.sync();
    } finally {
      await value.close();
    }
  },
  lockExclusive: (path) => acquireLock(path),
});
