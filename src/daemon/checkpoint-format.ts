import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { z } from "zod";
import type { DaemonConfig } from "./config.js";
import { encode, hash } from "../storage/store.js";
import { agentIdSchema } from "../domain/agents.js";
import type { HostHandle, HostOperations, HostStat } from "../deployment/host.js";

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
async function fsyncPath(host: HostOperations, path: string): Promise<void> {
  const handle = await host.openForRead(path);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function fsyncDirectory(host: HostOperations, path: string): Promise<void> {
  await host.fsyncDirectory(path);
}

export async function inventoryRegularFile(
  host: HostOperations,
  path: string,
  destination?: string,
): Promise<Omit<Extract<CheckpointEntry, { type: "file" }>, "path">> {
  const source = await host.openForRead(path);
  let target: HostHandle | undefined;
  try {
    const before = await source.stat();
    if (!before.isFile() || before.nlink !== 1)
      throw new Error("Checkpoint source must be one regular file without hard links");
    if (destination) target = await host.createExclusive(destination, 0o600);
    const digest = createHash("sha256"),
      buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const bytesRead = await source.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      if (target) {
        let written = 0;
        while (written < bytesRead)
          written += await target.write(buffer, written, bytesRead - written, offset + written);
      }
      offset += bytesRead;
    }
    if (target) await target.sync();
    const after = await source.stat(),
      pathAfter = await host.lstat(path);
    if (
      !sameIdentity(before, after) ||
      after.nlink !== 1 ||
      before.mode !== after.mode ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino ||
      offset !== before.size
    ) {
      if (destination) await host.remove(destination);
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

async function walk(
  host: HostOperations,
  root: string,
  copyRoot?: string,
): Promise<CheckpointEntry[]> {
  const entries: CheckpointEntry[] = [];
  const visit = async (relative: string): Promise<void> => {
    const source = relative ? join(root, ...relative.split("/")) : root,
      destination = copyRoot && relative ? join(copyRoot, ...relative.split("/")) : copyRoot;
    const before = await host.lstat(source);
    if (relative === "lost+found" && before.isDirectory()) return;
    if (before.isDirectory()) {
      if (relative) {
        entries.push({
          path: relative,
          type: "directory",
          mode: permissions(before),
        });
        if (destination) await host.mkdir(destination, 0o700);
      }
      if ((await host.canonical(source)) !== resolve(source))
        throw new Error("Checkpoint directory changed into a link");
      const names = (await host.readdir(source)).sort();
      for (const name of names) {
        if (!relative && name === "lost+found") continue;
        const child = relative ? `${relative}/${name}` : name;
        relativePath.parse(child);
        await visit(child);
      }
      const after = await host.lstat(source),
        again = (await host.readdir(source))
          .sort()
          .filter((name) => relative || name !== "lost+found");
      if (
        !after.isDirectory() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        (await host.canonical(source)) !== resolve(source) ||
        JSON.stringify(names.filter((name) => relative || name !== "lost+found")) !==
          JSON.stringify(again)
      )
        throw new Error("Checkpoint directory changed while reading");
      if (destination) await fsyncDirectory(host, destination);
      return;
    }
    if (before.isFile()) {
      const parent = dirname(source),
        parentBefore = await host.lstat(parent);
      if ((await host.canonical(parent)) !== resolve(parent))
        throw new Error("Checkpoint file parent changed into a link");
      const details = await inventoryRegularFile(host, source, destination),
        parentAfter = await host.lstat(parent);
      if (
        parentBefore.dev !== parentAfter.dev ||
        parentBefore.ino !== parentAfter.ino ||
        (await host.canonical(parent)) !== resolve(parent)
      )
        throw new Error("Checkpoint file parent changed while reading");
      entries.push({ path: relative, ...details });
      return;
    }
    if (before.isSymbolicLink()) {
      const parent = dirname(source),
        parentBefore = await host.lstat(parent);
      if ((await host.canonical(parent)) !== resolve(parent))
        throw new Error("Checkpoint symlink parent changed into a link");
      const target = await host.readlink(source);
      if (destination) await host.symlink(target, destination);
      const after = await host.lstat(source),
        parentAfter = await host.lstat(parent);
      if (
        !after.isSymbolicLink() ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        target !== (await host.readlink(source)) ||
        parentBefore.dev !== parentAfter.dev ||
        parentBefore.ino !== parentAfter.ino ||
        (await host.canonical(parent)) !== resolve(parent)
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
async function canonicalDirectory(host: HostOperations, root: string): Promise<string> {
  const stat = await host.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Checkpoint workspace root must be a directory, not a symlink");
  return host.canonical(root);
}
export async function copyWorkspace(
  host: HostOperations,
  root: string,
  destination: string,
): Promise<CheckpointEntry[]> {
  await host.mkdir(destination, 0o700);
  return walk(host, await canonicalDirectory(host, root), destination);
}
export async function inventoryWorkspace(
  host: HostOperations,
  root: string,
): Promise<CheckpointEntry[]> {
  return walk(host, await canonicalDirectory(host, root));
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
async function assertPayload(
  host: HostOperations,
  root: string,
  manifest: CheckpointManifest,
): Promise<void> {
  const top = (await host.readdir(root)).sort();
  if (encode(top) !== encode(["COMPLETE.json", "agents", "mate.sqlite"]))
    throw new Error("Checkpoint contains missing or extra top-level entries");
  if (!(await host.lstat(join(root, "agents"))).isDirectory())
    throw new Error("Checkpoint agents payload must be a directory");
  for (const path of [
    root,
    join(root, "agents"),
    join(root, "mate.sqlite"),
    join(root, "COMPLETE.json"),
  ]) {
    const stat = await host.lstat(path);
    if (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0)
      throw new Error("Checkpoint payload must be sealed against group or other writes");
  }
  const agentNames = (await host.readdir(join(root, "agents"))).sort();
  if (encode(agentNames) !== encode(manifest.agents.map((agent) => agent.agentId)))
    throw new Error("Checkpoint Agent directories do not match inventory");
  const databasePath = join(root, "mate.sqlite"),
    database = await inventoryRegularFile(host, databasePath);
  if (database.size !== manifest.database.size || database.sha256 !== manifest.database.sha256)
    throw new Error("Checkpoint database does not match inventory");
  for (const agent of manifest.agents) {
    const agentRoot = join(root, "agents", agent.agentId),
      agentRootStat = await host.lstat(agentRoot);
    if (!agentRootStat.isDirectory() || agentRootStat.isSymbolicLink())
      throw new Error("Checkpoint Agent payload must be a directory");
    if ((agentRootStat.mode & 0o022) !== 0)
      throw new Error("Checkpoint payload must be sealed against group or other writes");
    const actual = await inventoryWorkspace(host, agentRoot);
    if (actual.some((entry) => entry.type !== "symlink" && (entry.mode & 0o022) !== 0))
      throw new Error("Checkpoint payload must be sealed against group or other writes");
    if (payloadComparable(actual) !== payloadComparable(agent.entries))
      throw new Error(`Checkpoint workspace does not match inventory: ${agent.agentId}`);
  }
  if (
    encode((await host.readdir(root)).sort()) !== encode(top) ||
    encode((await host.readdir(join(root, "agents"))).sort()) !== encode(agentNames)
  )
    throw new Error("Checkpoint payload changed while validating");
}
export interface CheckpointTrust {
  requiredOwnerUid?: number;
  requiredOwnerGid?: number;
}
export async function verifyCheckpoint(
  host: HostOperations,
  path: string,
  config?: DaemonConfig,
  trust: CheckpointTrust = {},
): Promise<VerifiedCheckpoint> {
  const requested = resolve(path),
    root = await host.canonical(requested);
  if (root !== requested) throw new Error("Checkpoint path must be canonical");
  const rootStat = await host.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Checkpoint root must be a directory");
  const completePath = join(root, "COMPLETE.json"),
    complete = await host.openForRead(completePath);
  let completeStat: HostStat, bytes;
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
  await assertPayload(host, root, manifest);
  if (trust.requiredOwnerUid !== undefined || trust.requiredOwnerGid !== undefined) {
    const inspect = async (path: string, kind: "directory" | "file" | "symlink") => {
      const stat = await host.lstat(path);
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
  const rootAfter = await host.lstat(root),
    completeAfter = await host.openForRead(completePath);
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

async function sealTree(host: HostOperations, path: string): Promise<void> {
  const stat = await host.lstat(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of await host.readdir(path)) await sealTree(host, join(path, name));
    await host.chmod(path, 0o750);
    await fsyncDirectory(host, path);
    return;
  }
  if (stat.isFile()) {
    await host.chmod(path, 0o640);
    await fsyncPath(host, path);
    return;
  }
  throw new Error("Cannot seal special checkpoint file");
}

async function assertManagedOwnership(
  host: HostOperations,
  root: string,
  gid: number,
): Promise<void> {
  const visit = async (path: string): Promise<void> => {
    const stat = await host.lstat(path);
    if (stat.uid !== 0 || stat.gid !== gid)
      throw new Error(`Managed checkpoint ownership was not sealed: ${path}`);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if ((stat.mode & 0o777) !== 0o750)
        throw new Error(`Managed checkpoint directory mode was not sealed: ${path}`);
      for (const name of await host.readdir(path)) await visit(join(path, name));
      return;
    }
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o640)
      throw new Error(`Managed checkpoint file mode was not sealed: ${path}`);
  };
  await visit(root);
}

/** Root-only deployment boundary: make a completed checkpoint immutable to the service user. */
async function sealCheckpoint(
  host: HostOperations,
  path: string,
  serviceUid: number,
  serviceGid: number,
  resume?: IncompleteCheckpointIdentity,
): Promise<VerifiedCheckpoint> {
  if (host.euid() !== 0) throw new Error("Checkpoint sealing must run as root");
  if (
    !Number.isSafeInteger(serviceUid) ||
    serviceUid < 0 ||
    !Number.isSafeInteger(serviceGid) ||
    serviceGid < 0
  )
    throw new Error("Checkpoint service uid/gid must be valid");
  const before = await verifyCheckpoint(
      host,
      path,
      undefined,
      resume ? {} : { requiredOwnerUid: serviceUid, requiredOwnerGid: serviceGid },
    ),
    rootIdentity = await host.lstat(before.root),
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
  const sealHandle = async (current: string, expected: HostStat, kind: "directory" | "file") => {
    const handle =
      kind === "directory"
        ? await host.openDirectoryForRead(current)
        : await host.openForRead(current);
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
  const visit = async (current: string, expected?: HostStat): Promise<void> => {
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
      for (const name of (await host.readdir(current)).sort()) await visit(join(current, name));
      await fsyncDirectory(host, current);
      return;
    }
    if (stat.isFile()) {
      await sealHandle(current, stat, "file");
      return;
    }
    throw new Error("Cannot seal special checkpoint file");
  };
  await visit(before.root, rootIdentity);
  await fsyncDirectory(host, parent);
  const afterRoot = await host.lstat(before.root);
  if (rootIdentity.dev !== afterRoot.dev || rootIdentity.ino !== afterRoot.ino)
    throw new Error("Checkpoint root changed while sealing");
  await assertManagedOwnership(host, before.root, serviceGid);
  const after = await verifyCheckpoint(host, before.root);
  if (!sameCheckpointIdentity(before.identity, after.identity))
    throw new Error("Checkpoint identity changed while sealing");
  return after;
}

export async function sealCheckpointForService(
  host: HostOperations,
  path: string,
  serviceUid: number,
  serviceGid: number,
): Promise<VerifiedCheckpoint> {
  return sealCheckpoint(host, path, serviceUid, serviceGid);
}
/** Upgrade-only restart boundary: the root journal must have pinned this directory before backup. */
export async function resumeCheckpointSealForService(
  host: HostOperations,
  path: string,
  serviceUid: number,
  serviceGid: number,
  identity: IncompleteCheckpointIdentity,
): Promise<VerifiedCheckpoint> {
  return sealCheckpoint(host, path, serviceUid, serviceGid, identity);
}
/** Test-only ownership check; production entry points do not accept an ownership override. */
export async function resumeCheckpointSealForTesting(
  host: HostOperations,
  path: string,
  serviceUid: number,
  serviceGid: number,
  identity: IncompleteCheckpointIdentity,
): Promise<VerifiedCheckpoint> {
  if (!process.env.VITEST) throw new Error("Checkpoint sealing overrides are test-only");
  return sealCheckpoint(host, path, serviceUid, serviceGid, identity);
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
  host: HostOperations,
  path: string,
): Promise<IncompleteCheckpointIdentity> {
  const requested = resolve(path),
    root = await host.canonical(requested);
  if (root !== requested) throw new Error("Incomplete checkpoint path must be canonical");
  const stat = await host.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Incomplete checkpoint must be a directory");
  try {
    await host.lstat(join(root, "COMPLETE.json"));
    throw new Error("Completed checkpoint must never be removed as incomplete");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { path: root, device: stat.dev, inode: stat.ino };
}

/** Root-only cleanup paired with the identity captured before invoking the service-user backup. */
async function cleanupIncompleteCheckpoint(
  host: HostOperations,
  identity: IncompleteCheckpointIdentity,
  keepRoot: boolean,
): Promise<void> {
  if (host.euid() !== 0) throw new Error("Incomplete checkpoint cleanup must run as root");
  const current = await inspectIncompleteCheckpoint(host, identity.path);
  if (current.device !== identity.device || current.inode !== identity.inode)
    throw new Error("Incomplete checkpoint directory was replaced");
  const parent = dirname(identity.path),
    parentBefore = await host.lstat(parent);
  if (keepRoot) {
    for (const name of await host.readdir(identity.path))
      await host.remove(join(identity.path, name), { recursive: true });
    await fsyncDirectory(host, identity.path);
  } else await host.remove(identity.path, { recursive: true, force: false });
  const parentAfter = await host.lstat(parent);
  if (parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino)
    throw new Error("Checkpoint parent changed during cleanup");
  await fsyncDirectory(host, parent);
}
export async function removeIncompleteCheckpoint(
  host: HostOperations,
  identity: IncompleteCheckpointIdentity,
): Promise<void> {
  return cleanupIncompleteCheckpoint(host, identity, false);
}
/** Preserve the directory inode already pinned by the root upgrade journal. */
export async function resetIncompleteCheckpoint(
  host: HostOperations,
  identity: IncompleteCheckpointIdentity,
): Promise<void> {
  return cleanupIncompleteCheckpoint(host, identity, true);
}

export async function publishCheckpoint(
  host: HostOperations,
  root: string,
  manifest: CheckpointManifest,
): Promise<void> {
  const validated = validateCheckpointManifest(manifest);
  await sealTree(host, root);
  const temporary = join(root, `.COMPLETE-${randomUUID()}`),
    handle = await host.createExclusive(temporary, 0o600);
  let published = false;
  try {
    await handle.writeFile(JSON.stringify(validated));
    await handle.sync();
    await handle.close();
    await host.chmod(temporary, 0o640);
    await fsyncPath(host, temporary);
    await host.rename(temporary, join(root, "COMPLETE.json"));
    published = true;
    await fsyncDirectory(host, root);
    await fsyncDirectory(host, dirname(root));
  } finally {
    if (!published) {
      await handle.close().catch(() => {});
      await host.remove(temporary);
    }
  }
}
export async function restoreRegularFile(
  host: HostOperations,
  source: string,
  destination: string,
  expected: { size: number; sha256: string; mode: number },
): Promise<void> {
  const sourceParent = dirname(source),
    destinationParent = dirname(destination),
    sourceParentBefore = await host.lstat(sourceParent),
    destinationParentBefore = await host.lstat(destinationParent);
  if (
    !sourceParentBefore.isDirectory() ||
    sourceParentBefore.isSymbolicLink() ||
    (await host.canonical(sourceParent)) !== resolve(sourceParent) ||
    !destinationParentBefore.isDirectory() ||
    destinationParentBefore.isSymbolicLink() ||
    (await host.canonical(destinationParent)) !== resolve(destinationParent)
  )
    throw new Error("Checkpoint copy parents must be canonical directories");
  const temporary = join(destinationParent, `.${basename(destination)}.restore-${randomUUID()}`);
  let renamed = false;
  try {
    const actual = await inventoryRegularFile(host, source, temporary);
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256)
      throw new Error("Checkpoint file changed while restoring");
    const sourceParentAfter = await host.lstat(sourceParent),
      destinationParentAfter = await host.lstat(destinationParent);
    if (
      sourceParentBefore.dev !== sourceParentAfter.dev ||
      sourceParentBefore.ino !== sourceParentAfter.ino ||
      destinationParentBefore.dev !== destinationParentAfter.dev ||
      destinationParentBefore.ino !== destinationParentAfter.ino ||
      (await host.canonical(sourceParent)) !== resolve(sourceParent) ||
      (await host.canonical(destinationParent)) !== resolve(destinationParent)
    )
      throw new Error("Checkpoint copy parent changed while restoring");
    await host.chmod(temporary, expected.mode);
    await fsyncPath(host, temporary);
    await host.rename(temporary, destination);
    renamed = true;
    await fsyncDirectory(host, destinationParent);
  } finally {
    if (!renamed) await host.remove(temporary);
  }
}
