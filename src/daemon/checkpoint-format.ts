import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import {
  chmod,
  lchown,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { z } from "zod";
import type { DaemonConfig } from "./config.js";
import { encode, hash } from "../storage/store.js";
import { agentIdSchema } from "../domain/agents.js";

const relativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value !== "." &&
      !value.includes("\0") &&
      !isAbsolute(value) &&
      !value.includes("\\") &&
      posix.normalize(value) === value &&
      !value.split("/").includes(".."),
    "Canonical relative path required",
  );
const mode = z.number().int().min(0).max(0o7777);
const directoryEntry = z
  .object({ path: relativePath, type: z.literal("directory"), mode })
  .strict();
const fileEntry = z
  .object({
    path: relativePath,
    type: z.literal("file"),
    mode,
    size: z.number().int().nonnegative(),
    allocatedBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const symlinkEntry = z
  .object({
    path: relativePath,
    type: z.literal("symlink"),
    mode,
    target: z.string(),
  })
  .strict();
export const checkpointEntrySchema = z.discriminatedUnion("type", [
  directoryEntry,
  fileEntry,
  symlinkEntry,
]);
export type CheckpointEntry = z.infer<typeof checkpointEntrySchema>;
const fileInventory = fileEntry
  .omit({ path: true, mode: true })
  .extend({ path: z.literal("mate.sqlite"), mode })
  .strict();
export const checkpointManifestSchema = z
  .object({
    version: z.literal(2),
    dataDir: z.string().refine(isAbsolute, "Absolute path required"),
    at: z.iso.datetime(),
    configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
    agents: z.array(
      z
        .object({
          agentId: agentIdSchema,
          entries: z.array(checkpointEntrySchema),
        })
        .strict(),
    ),
    database: fileInventory.extend({ sourceSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  })
  .strict();
export type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;
export interface CheckpointIdentity {
  path: string;
  device: number;
  inode: number;
  manifestDevice: number;
  manifestInode: number;
  manifestHash: string;
}
export interface VerifiedCheckpoint {
  root: string;
  manifest: CheckpointManifest;
  identity: CheckpointIdentity;
}
export interface IncompleteCheckpointIdentity {
  path: string;
  device: number;
  inode: number;
}

export function configurationHash(config: DaemonConfig): string {
  return hash(encode(config));
}
function permissions(value: { mode: number }): number {
  return value.mode & 0o7777;
}
function sameIdentity(
  left: { dev: number; ino: number; size: number; mtimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}
async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function inventoryRegularFile(
  path: string,
  destination?: string,
): Promise<Omit<Extract<CheckpointEntry, { type: "file" }>, "path">> {
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let target: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await source.stat();
    if (!before.isFile() || before.nlink !== 1)
      throw new Error("Checkpoint source must be one regular file without hard links");
    if (destination)
      target = await open(
        destination,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    const digest = createHash("sha256"),
      buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      if (target) {
        let written = 0;
        while (written < bytesRead)
          written += (await target.write(buffer, written, bytesRead - written, offset + written))
            .bytesWritten;
      }
      offset += bytesRead;
    }
    if (target) await target.sync();
    const after = await source.stat(),
      pathAfter = await lstat(path);
    if (
      !sameIdentity(before, after) ||
      after.nlink !== 1 ||
      before.mode !== after.mode ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      offset !== before.size
    ) {
      if (destination) await rm(destination, { force: true });
      throw new Error("Checkpoint source changed while reading");
    }
    return {
      type: "file",
      mode: permissions(before),
      size: before.size,
      allocatedBytes: before.blocks * 512,
      sha256: digest.digest("hex"),
    };
  } finally {
    await target?.close();
    await source.close();
  }
}

function validateEntries(entries: readonly CheckpointEntry[]): void {
  let previous = "";
  const known = new Map<string, CheckpointEntry>();
  for (const entry of entries) {
    if (previous && entry.path <= previous)
      throw new Error("Checkpoint entries must be uniquely sorted");
    previous = entry.path;
    const parent = posix.dirname(entry.path);
    if (parent !== "." && known.get(parent)?.type !== "directory")
      throw new Error("Checkpoint entry parent must be an inventoried directory");
    known.set(entry.path, entry);
  }
}
export function validateCheckpointManifest(input: unknown): CheckpointManifest {
  const manifest = checkpointManifestSchema.parse(input);
  let previous = "";
  for (const agent of manifest.agents) {
    if (previous && agent.agentId <= previous)
      throw new Error("Checkpoint Agents must be uniquely sorted");
    previous = agent.agentId;
    validateEntries(agent.entries);
  }
  return manifest;
}

async function walk(root: string, copyRoot?: string): Promise<CheckpointEntry[]> {
  const entries: CheckpointEntry[] = [];
  const visit = async (relative: string): Promise<void> => {
    const source = relative ? join(root, ...relative.split("/")) : root,
      destination = copyRoot && relative ? join(copyRoot, ...relative.split("/")) : copyRoot;
    const before = await lstat(source);
    if (relative === "lost+found" && before.isDirectory()) return;
    if (before.isDirectory()) {
      if (relative) {
        entries.push({
          path: relative,
          type: "directory",
          mode: permissions(before),
        });
        if (destination) await mkdir(destination, { mode: 0o700 });
      }
      if ((await realpath(source)) !== resolve(source))
        throw new Error("Checkpoint directory changed into a link");
      const names = (await readdir(source)).sort();
      for (const name of names) {
        if (!relative && name === "lost+found") continue;
        const child = relative ? `${relative}/${name}` : name;
        relativePath.parse(child);
        await visit(child);
      }
      const after = await lstat(source),
        again = (await readdir(source)).sort().filter((name) => relative || name !== "lost+found");
      if (
        !after.isDirectory() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        (await realpath(source)) !== resolve(source) ||
        JSON.stringify(names.filter((name) => relative || name !== "lost+found")) !==
          JSON.stringify(again)
      )
        throw new Error("Checkpoint directory changed while reading");
      if (destination) await fsyncDirectory(destination);
      return;
    }
    if (before.isFile()) {
      const parent = dirname(source),
        parentBefore = await lstat(parent);
      if ((await realpath(parent)) !== resolve(parent))
        throw new Error("Checkpoint file parent changed into a link");
      const details = await inventoryRegularFile(source, destination),
        parentAfter = await lstat(parent);
      if (
        parentBefore.dev !== parentAfter.dev ||
        parentBefore.ino !== parentAfter.ino ||
        (await realpath(parent)) !== resolve(parent)
      )
        throw new Error("Checkpoint file parent changed while reading");
      entries.push({ path: relative, ...details });
      return;
    }
    if (before.isSymbolicLink()) {
      const parent = dirname(source),
        parentBefore = await lstat(parent);
      if ((await realpath(parent)) !== resolve(parent))
        throw new Error("Checkpoint symlink parent changed into a link");
      const target = await readlink(source);
      if (destination) await symlink(target, destination);
      const after = await lstat(source),
        parentAfter = await lstat(parent);
      if (
        !after.isSymbolicLink() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        target !== (await readlink(source)) ||
        parentBefore.dev !== parentAfter.dev ||
        parentBefore.ino !== parentAfter.ino ||
        (await realpath(parent)) !== resolve(parent)
      )
        throw new Error("Checkpoint symlink changed while reading");
      entries.push({
        path: relative,
        type: "symlink",
        mode: permissions(before),
        target,
      });
      return;
    }
    throw new Error(`Checkpoint contains unsupported special file: ${relative}`);
  };
  await visit("");
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  validateEntries(entries);
  return entries;
}
async function canonicalDirectory(root: string): Promise<string> {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Checkpoint workspace root must be a directory, not a symlink");
  return realpath(root);
}
export async function copyWorkspace(root: string, destination: string): Promise<CheckpointEntry[]> {
  await mkdir(destination, { mode: 0o700 });
  return walk(await canonicalDirectory(root), destination);
}
export async function inventoryWorkspace(root: string): Promise<CheckpointEntry[]> {
  return walk(await canonicalDirectory(root));
}

function payloadShape(entry: CheckpointEntry): unknown {
  return entry.type === "file"
    ? {
        path: entry.path,
        type: entry.type,
        size: entry.size,
        sha256: entry.sha256,
      }
    : entry.type === "symlink"
      ? { path: entry.path, type: entry.type, target: entry.target }
      : { path: entry.path, type: entry.type };
}
function payloadComparable(entries: readonly CheckpointEntry[]): string {
  return encode(entries.map(payloadShape));
}
async function assertPayload(root: string, manifest: CheckpointManifest): Promise<void> {
  const top = (await readdir(root)).sort();
  if (encode(top) !== encode(["COMPLETE.json", "agents", "mate.sqlite"]))
    throw new Error("Checkpoint contains missing or extra top-level entries");
  if (!(await lstat(join(root, "agents"))).isDirectory())
    throw new Error("Checkpoint agents payload must be a directory");
  for (const path of [
    root,
    join(root, "agents"),
    join(root, "mate.sqlite"),
    join(root, "COMPLETE.json"),
  ]) {
    const stat = await lstat(path);
    if (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0)
      throw new Error("Checkpoint payload must be sealed against group or other writes");
  }
  const agentNames = (await readdir(join(root, "agents"))).sort();
  if (encode(agentNames) !== encode(manifest.agents.map((agent) => agent.agentId)))
    throw new Error("Checkpoint Agent directories do not match inventory");
  const databasePath = join(root, "mate.sqlite"),
    database = await inventoryRegularFile(databasePath);
  if (database.size !== manifest.database.size || database.sha256 !== manifest.database.sha256)
    throw new Error("Checkpoint database does not match inventory");
  for (const agent of manifest.agents) {
    const agentRoot = join(root, "agents", agent.agentId),
      agentRootStat = await lstat(agentRoot);
    if (!agentRootStat.isDirectory() || agentRootStat.isSymbolicLink())
      throw new Error("Checkpoint Agent payload must be a directory");
    if ((agentRootStat.mode & 0o022) !== 0)
      throw new Error("Checkpoint payload must be sealed against group or other writes");
    const actual = await inventoryWorkspace(agentRoot);
    if (actual.some((entry) => entry.type !== "symlink" && (entry.mode & 0o022) !== 0))
      throw new Error("Checkpoint payload must be sealed against group or other writes");
    if (payloadComparable(actual) !== payloadComparable(agent.entries))
      throw new Error(`Checkpoint workspace does not match inventory: ${agent.agentId}`);
  }
  if (
    encode((await readdir(root)).sort()) !== encode(top) ||
    encode((await readdir(join(root, "agents"))).sort()) !== encode(agentNames)
  )
    throw new Error("Checkpoint payload changed while validating");
}
export interface CheckpointTrust {
  requiredOwnerUid?: number;
  requiredOwnerGid?: number;
}
export interface CheckpointSealingHost {
  uid(): number;
  lchown(path: string, uid: number, gid: number): Promise<void>;
  lstat(path: string): Promise<Stats>;
  open(
    path: string,
    flags: number,
  ): Promise<{
    stat(): Promise<Stats>;
    chown(uid: number, gid: number): Promise<void>;
    chmod(mode: number): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
}
const nodeCheckpointSealingHost: CheckpointSealingHost = {
  uid: () => process.geteuid?.() ?? process.getuid?.() ?? -1,
  lchown,
  lstat,
  open: (path, flags) => open(path, flags),
};
export async function verifyCheckpoint(
  path: string,
  config?: DaemonConfig,
  trust: CheckpointTrust = {},
): Promise<VerifiedCheckpoint> {
  const requested = resolve(path),
    root = await realpath(requested);
  if (root !== requested) throw new Error("Checkpoint path must be canonical");
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Checkpoint root must be a directory");
  const completePath = join(root, "COMPLETE.json"),
    complete = await open(completePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let completeStat, bytes;
  try {
    const before = await complete.stat();
    bytes = await complete.readFile();
    const after = await complete.stat();
    if (!before.isFile() || before.nlink !== 1 || !sameIdentity(before, after))
      throw new Error("Checkpoint completion marker changed while reading");
    completeStat = after;
  } finally {
    await complete.close();
  }
  const manifest = validateCheckpointManifest(JSON.parse(bytes.toString("utf8")));
  if (config) {
    if (
      manifest.dataDir !== resolve(config.runtime.dataDir) ||
      manifest.configurationHash !== configurationHash(config)
    )
      throw new Error("Checkpoint does not match the requested data directory and configuration");
    const expected = config.mate.agents.map((agent) => agent.id).sort();
    if (encode(manifest.agents.map((agent) => agent.agentId)) !== encode(expected))
      throw new Error("Checkpoint Agent identities do not match configuration");
  }
  await assertPayload(root, manifest);
  if (trust.requiredOwnerUid !== undefined || trust.requiredOwnerGid !== undefined) {
    const inspect = async (path: string, kind: "directory" | "file" | "symlink") => {
      const stat = await lstat(path);
      if (
        (trust.requiredOwnerUid !== undefined && stat.uid !== trust.requiredOwnerUid) ||
        (trust.requiredOwnerGid !== undefined && stat.gid !== trust.requiredOwnerGid)
      )
        throw new Error(
          `Managed restore requires one root-owned service-group checkpoint tree: ${path}`,
        );
      if (kind === "directory" && (stat.mode & 0o777) !== 0o750)
        throw new Error("Managed checkpoint directories must be sealed 0750");
      if (kind === "file" && (stat.mode & 0o777) !== 0o640)
        throw new Error("Managed checkpoint files must be sealed 0640");
    };
    await inspect(root, "directory");
    await inspect(join(root, "agents"), "directory");
    await inspect(completePath, "file");
    await inspect(join(root, "mate.sqlite"), "file");
    for (const agent of manifest.agents) {
      const agentRoot = join(root, "agents", agent.agentId);
      await inspect(agentRoot, "directory");
      for (const entry of agent.entries)
        await inspect(join(agentRoot, ...entry.path.split("/")), entry.type);
    }
  }
  const rootAfter = await lstat(root),
    completeAfter = await open(completePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await completeAfter.stat(),
      again = await completeAfter.readFile();
    if (
      rootStat.dev !== rootAfter.dev ||
      rootStat.ino !== rootAfter.ino ||
      completeStat.dev !== stat.dev ||
      completeStat.ino !== stat.ino ||
      createHash("sha256").update(again).digest("hex") !==
        createHash("sha256").update(bytes).digest("hex")
    )
      throw new Error("Checkpoint identity changed while validating");
  } finally {
    await completeAfter.close();
  }
  return {
    root,
    manifest,
    identity: {
      path: root,
      device: rootStat.dev,
      inode: rootStat.ino,
      manifestDevice: completeStat.dev,
      manifestInode: completeStat.ino,
      manifestHash: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

async function sealTree(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of await readdir(path)) await sealTree(join(path, name));
    await chmod(path, 0o750);
    await fsyncDirectory(path);
    return;
  }
  if (stat.isFile()) {
    await chmod(path, 0o640);
    await fsyncPath(path);
    return;
  }
  throw new Error("Cannot seal special checkpoint file");
}

async function assertManagedOwnership(
  root: string,
  gid: number,
  host: CheckpointSealingHost,
): Promise<void> {
  const visit = async (path: string): Promise<void> => {
    const stat = await host.lstat(path);
    if (stat.uid !== 0 || stat.gid !== gid)
      throw new Error(`Managed checkpoint ownership was not sealed: ${path}`);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if ((stat.mode & 0o777) !== 0o750)
        throw new Error(`Managed checkpoint directory mode was not sealed: ${path}`);
      for (const name of await readdir(path)) await visit(join(path, name));
      return;
    }
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o640)
      throw new Error(`Managed checkpoint file mode was not sealed: ${path}`);
  };
  await visit(root);
}

/** Root-only deployment boundary: make a completed checkpoint immutable to the service user. */
async function sealCheckpoint(
  path: string,
  serviceUid: number,
  serviceGid: number,
  resume?: IncompleteCheckpointIdentity,
  host: CheckpointSealingHost = nodeCheckpointSealingHost,
): Promise<VerifiedCheckpoint> {
  if (host.uid() !== 0) throw new Error("Checkpoint sealing must run as root");
  if (
    !Number.isSafeInteger(serviceUid) ||
    serviceUid < 0 ||
    !Number.isSafeInteger(serviceGid) ||
    serviceGid < 0
  )
    throw new Error("Checkpoint service uid/gid must be valid");
  const before = await verifyCheckpoint(
      path,
      undefined,
      resume ? {} : { requiredOwnerUid: serviceUid, requiredOwnerGid: serviceGid },
    ),
    rootIdentity = await lstat(before.root),
    parent = dirname(before.root),
    parentStat = await host.lstat(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    parentStat.uid !== 0 ||
    parentStat.gid !== serviceGid ||
    (parentStat.mode & 0o777) !== 0o750
  )
    throw new Error("Checkpoint parent must be root:service-group 0750");
  if (
    resume &&
    (resolve(resume.path) !== before.root ||
      resume.device !== rootIdentity.dev ||
      resume.inode !== rootIdentity.ino)
  )
    throw new Error("Checkpoint sealing resume identity changed");
  const sealHandle = async (current: string, expected: Stats, kind: "directory" | "file") => {
    const flags =
        constants.O_RDONLY |
        constants.O_NOFOLLOW |
        (kind === "directory" ? constants.O_DIRECTORY : 0),
      handle = await host.open(current, flags);
    try {
      const opened = await handle.stat();
      if (
        opened.dev !== expected.dev ||
        opened.ino !== expected.ino ||
        (kind === "directory" ? !opened.isDirectory() : !opened.isFile()) ||
        opened.nlink !== expected.nlink
      )
        throw new Error("Checkpoint entry changed while sealing");
      await handle.chown(0, serviceGid);
      await handle.chmod(kind === "directory" ? 0o750 : 0o640);
      await handle.sync();
      const after = await handle.stat();
      if (after.dev !== opened.dev || after.ino !== opened.ino)
        throw new Error("Checkpoint entry changed while sealing");
    } finally {
      await handle.close();
    }
  };
  const visit = async (current: string, expected?: Stats): Promise<void> => {
    const stat = expected ?? (await host.lstat(current));
    if (resume && (![0, serviceUid].includes(stat.uid) || stat.gid !== serviceGid))
      throw new Error("Checkpoint sealing resume owner changed");
    if (stat.isSymbolicLink()) {
      await host.lchown(current, 0, serviceGid);
      const after = await host.lstat(current);
      if (
        !after.isSymbolicLink() ||
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.uid !== 0 ||
        after.gid !== serviceGid
      )
        throw new Error("Checkpoint symlink changed while sealing");
      return;
    }
    if (stat.isDirectory()) {
      // Revoke service writes through the pinned directory fd before enumerating its children.
      await sealHandle(current, stat, "directory");
      for (const name of (await readdir(current)).sort()) await visit(join(current, name));
      await fsyncDirectory(current);
      return;
    }
    if (stat.isFile()) {
      await sealHandle(current, stat, "file");
      return;
    }
    throw new Error("Cannot seal special checkpoint file");
  };
  await visit(before.root, rootIdentity);
  await fsyncDirectory(parent);
  const afterRoot = await lstat(before.root);
  if (rootIdentity.dev !== afterRoot.dev || rootIdentity.ino !== afterRoot.ino)
    throw new Error("Checkpoint root changed while sealing");
  await assertManagedOwnership(before.root, serviceGid, host);
  const after = await verifyCheckpoint(before.root);
  if (!sameCheckpointIdentity(before.identity, after.identity))
    throw new Error("Checkpoint identity changed while sealing");
  return after;
}

export async function sealCheckpointForService(
  path: string,
  serviceUid: number,
  serviceGid: number,
): Promise<VerifiedCheckpoint> {
  return sealCheckpoint(path, serviceUid, serviceGid);
}
/** Upgrade-only restart boundary: the root journal must have pinned this directory before backup. */
export async function resumeCheckpointSealForService(
  path: string,
  serviceUid: number,
  serviceGid: number,
  identity: IncompleteCheckpointIdentity,
): Promise<VerifiedCheckpoint> {
  return sealCheckpoint(path, serviceUid, serviceGid, identity);
}
/** Test-only ownership host; production entry points do not accept it. */
export async function resumeCheckpointSealForTesting(
  path: string,
  serviceUid: number,
  serviceGid: number,
  identity: IncompleteCheckpointIdentity,
  host: CheckpointSealingHost,
): Promise<VerifiedCheckpoint> {
  if (!process.env.VITEST) throw new Error("Checkpoint sealing host override is test-only");
  return sealCheckpoint(path, serviceUid, serviceGid, identity, host);
}

export function sameCheckpointIdentity(
  left: CheckpointIdentity,
  right: CheckpointIdentity,
): boolean {
  return (
    left.path === right.path &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.manifestDevice === right.manifestDevice &&
    left.manifestInode === right.manifestInode &&
    left.manifestHash === right.manifestHash
  );
}

/** Capture the exact unfinished directory a privileged wrapper may remove after a failed backup. */
export async function inspectIncompleteCheckpoint(
  path: string,
): Promise<IncompleteCheckpointIdentity> {
  const requested = resolve(path),
    root = await realpath(requested);
  if (root !== requested) throw new Error("Incomplete checkpoint path must be canonical");
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Incomplete checkpoint must be a directory");
  try {
    await lstat(join(root, "COMPLETE.json"));
    throw new Error("Completed checkpoint must never be removed as incomplete");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { path: root, device: stat.dev, inode: stat.ino };
}

/** Root-only cleanup paired with the identity captured before invoking the service-user backup. */
async function cleanupIncompleteCheckpoint(
  identity: IncompleteCheckpointIdentity,
  keepRoot: boolean,
): Promise<void> {
  if ((process.geteuid?.() ?? process.getuid?.() ?? -1) !== 0)
    throw new Error("Incomplete checkpoint cleanup must run as root");
  const current = await inspectIncompleteCheckpoint(identity.path);
  if (current.device !== identity.device || current.inode !== identity.inode)
    throw new Error("Incomplete checkpoint directory was replaced");
  const parent = dirname(identity.path),
    parentBefore = await lstat(parent);
  if (keepRoot) {
    for (const name of await readdir(identity.path))
      await rm(join(identity.path, name), { recursive: true, force: true });
    await fsyncDirectory(identity.path);
  } else await rm(identity.path, { recursive: true });
  const parentAfter = await lstat(parent);
  if (parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino)
    throw new Error("Checkpoint parent changed during cleanup");
  await fsyncDirectory(parent);
}
export async function removeIncompleteCheckpoint(
  identity: IncompleteCheckpointIdentity,
): Promise<void> {
  return cleanupIncompleteCheckpoint(identity, false);
}
/** Preserve the directory inode already pinned by the root upgrade journal. */
export async function resetIncompleteCheckpoint(
  identity: IncompleteCheckpointIdentity,
): Promise<void> {
  return cleanupIncompleteCheckpoint(identity, true);
}

export async function publishCheckpoint(root: string, manifest: CheckpointManifest): Promise<void> {
  const validated = validateCheckpointManifest(manifest);
  await sealTree(root);
  const temporary = join(root, `.COMPLETE-${randomUUID()}`),
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  let published = false;
  try {
    await handle.writeFile(JSON.stringify(validated));
    await handle.sync();
    await handle.close();
    await chmod(temporary, 0o640);
    await fsyncPath(temporary);
    await rename(temporary, join(root, "COMPLETE.json"));
    published = true;
    await fsyncDirectory(root);
    await fsyncDirectory(dirname(root));
  } finally {
    if (!published) {
      await handle.close().catch(() => {});
      await rm(temporary, { force: true });
    }
  }
}
export async function restoreRegularFile(
  source: string,
  destination: string,
  expected: { size: number; sha256: string; mode: number },
): Promise<void> {
  const sourceParent = dirname(source),
    destinationParent = dirname(destination),
    sourceParentBefore = await lstat(sourceParent),
    destinationParentBefore = await lstat(destinationParent);
  if (
    !sourceParentBefore.isDirectory() ||
    sourceParentBefore.isSymbolicLink() ||
    (await realpath(sourceParent)) !== resolve(sourceParent) ||
    !destinationParentBefore.isDirectory() ||
    destinationParentBefore.isSymbolicLink() ||
    (await realpath(destinationParent)) !== resolve(destinationParent)
  )
    throw new Error("Checkpoint copy parents must be canonical directories");
  const temporary = join(destinationParent, `.${basename(destination)}.restore-${randomUUID()}`);
  let renamed = false;
  try {
    const actual = await inventoryRegularFile(source, temporary);
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256)
      throw new Error("Checkpoint file changed while restoring");
    const sourceParentAfter = await lstat(sourceParent),
      destinationParentAfter = await lstat(destinationParent);
    if (
      sourceParentBefore.dev !== sourceParentAfter.dev ||
      sourceParentBefore.ino !== sourceParentAfter.ino ||
      destinationParentBefore.dev !== destinationParentAfter.dev ||
      destinationParentBefore.ino !== destinationParentAfter.ino ||
      (await realpath(sourceParent)) !== resolve(sourceParent) ||
      (await realpath(destinationParent)) !== resolve(destinationParent)
    )
      throw new Error("Checkpoint copy parent changed while restoring");
    await chmod(temporary, expected.mode);
    await fsyncPath(temporary);
    await rename(temporary, destination);
    renamed = true;
    await fsyncDirectory(destinationParent);
  } finally {
    if (!renamed) await rm(temporary, { force: true });
  }
}
