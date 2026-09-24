import { randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync, statfsSync } from "node:fs";
import {
  chmod,
  chown,
  lchown,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { DaemonConfig } from "./config.js";
import { encode } from "../storage/store.js";
import {
  fsyncDirectory,
  inventoryRegularFile,
  inventoryWorkspace,
  restoreRegularFile,
  verifyCheckpoint,
  type CheckpointEntry,
  type CheckpointIdentity,
  type CheckpointManifest,
  type VerifiedCheckpoint,
} from "./checkpoint-format.js";
import { within } from "../execution/paths.js";
import { acquireLock } from "./lock.js";
import { linuxUpgradeInProgress } from "../deployment/linux-upgrade-guard.js";

const identitySchema = z
  .object({
    path: z.string(),
    device: z.number().int(),
    inode: z.number().int(),
    manifestDevice: z.number().int(),
    manifestInode: z.number().int(),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const journalSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(["planned", "decided"]),
    configurationHash: z.string(),
    target: identitySchema,
    current: identitySchema.optional(),
    completedAgents: z.array(z.string()),
    databaseComplete: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.completedAgents).size !== value.completedAgents.length)
      ctx.addIssue({
        code: "custom",
        message: "Restore journal contains duplicate Agent completions",
      });
  });
type RestoreJournal = z.infer<typeof journalSchema>;
export type RestorePhase = "decision" | `agent:${string}` | "database";
export interface RestoreOptions {
  currentCheckpoint?: string;
  afterPhase?: (phase: RestorePhase) => void | Promise<void>;
}
interface RestoreTestingOptions extends RestoreOptions {
  checkpointOwnerUid?: number;
  checkpointOwnerGid?: number;
  retainJournal?: boolean;
}

function identityEqual(left: CheckpointIdentity, right: CheckpointIdentity): boolean {
  return encode(left) === encode(right);
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path),
    temporary = join(parent, `.restore-${randomUUID()}`),
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  let renamed = false;
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    renamed = true;
    await fsyncDirectory(parent);
  } finally {
    if (!renamed) {
      await handle.close().catch(() => {});
      await rm(temporary, { force: true });
    }
  }
}
async function removeNamedTemps(directory: string, prefix: string): Promise<void> {
  for (const name of await readdir(directory))
    if (name.startsWith(prefix)) await rm(join(directory, name), { recursive: false, force: true });
  await fsyncDirectory(directory);
}
async function readJournal(path: string): Promise<RestoreJournal | undefined> {
  if (!(await exists(path))) return undefined;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return journalSchema.parse(JSON.parse((await handle.readFile()).toString("utf8")));
  } finally {
    await handle.close();
  }
}
export async function assertNoRestoreInProgress(dataDir: string): Promise<void> {
  const control = join(dataDir, "control");
  if (await exists(control)) {
    const stat = await lstat(control);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Restore control path must be a directory");
  }
  if (await exists(join(control, "restore.json")))
    throw new Error("Managed restore is incomplete; resume the restore before starting Mate");
}

function agentManifest(manifest: CheckpointManifest, agentId: string) {
  const agent = manifest.agents.find((value) => value.agentId === agentId);
  if (!agent) throw new Error("Checkpoint Agent inventory missing");
  return agent;
}
function requiredBytes(entries: readonly CheckpointEntry[], blockSize: number): bigint {
  const block = BigInt(blockSize),
    rounded = (value: number) => ((BigInt(value) + block - 1n) / block) * block;
  return entries.reduce(
    (total, entry) =>
      total +
      (entry.type === "file"
        ? rounded(entry.size) > BigInt(entry.allocatedBytes)
          ? rounded(entry.size)
          : BigInt(entry.allocatedBytes)
        : block),
    16n * 1024n * 1024n,
  );
}
async function nonempty(path: string): Promise<boolean> {
  if (!(await exists(path))) return false;
  return (await readdir(path)).some((name) => name !== "lost+found");
}
async function assertLiveMatches(
  checkpoint: VerifiedCheckpoint,
  roots: ReadonlyMap<string, string>,
  dataDir: string,
): Promise<void> {
  const databasePath = join(dataDir, "state", "mate.sqlite");
  if (!(await exists(databasePath)))
    throw new Error("Current state checkpoint does not match the live database");
  const actual = await inventoryRegularFile(databasePath),
    wal = `${databasePath}-wal`;
  if (
    actual.sha256 !== checkpoint.manifest.database.sourceSha256 ||
    ((await exists(wal)) && (await lstat(wal)).size > 0)
  )
    throw new Error("Current state checkpoint does not match the live database");
  for (const [agentId, root] of roots) {
    if (
      !(await exists(root)) ||
      encode(await inventoryWorkspace(root)) !==
        encode(agentManifest(checkpoint.manifest, agentId).entries)
    )
      throw new Error(`Current state checkpoint does not match live workspace: ${agentId}`);
  }
}
async function clearWorkspace(root: string): Promise<void> {
  for (const name of await readdir(root))
    if (name !== "lost+found") await rm(join(root, name), { recursive: true, force: true });
  await fsyncDirectory(root);
}
async function restoreWorkspace(
  checkpointRoot: string,
  agentId: string,
  root: string,
  entries: readonly CheckpointEntry[],
): Promise<void> {
  const rootStat = await lstat(root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (await realpath(root)) !== resolve(root)
  )
    throw new Error("Private workspace mount disappeared before restore");
  await clearWorkspace(root);
  const sourceRoot = join(checkpointRoot, "agents", agentId);
  for (const entry of entries) {
    const destination = join(root, ...entry.path.split("/"));
    if (entry.type === "directory") await mkdir(destination, { mode: 0o700 });
    else if (entry.type === "file")
      await restoreRegularFile(join(sourceRoot, ...entry.path.split("/")), destination, entry);
    else {
      const temporary = `${destination}.restore-${randomUUID()}`;
      await symlink(entry.target, temporary);
      await rename(temporary, destination);
      await fsyncDirectory(dirname(destination));
    }
  }
  for (const entry of [...entries].reverse())
    if (entry.type === "directory") {
      await chmod(join(root, ...entry.path.split("/")), entry.mode);
      await fsyncDirectory(join(root, ...entry.path.split("/")));
    }
  await fsyncDirectory(root);
}
async function restoreLinuxOwnership(
  root: string,
  uid: number,
  gid: number,
  entries: readonly CheckpointEntry[],
): Promise<void> {
  for (const entry of [...entries].reverse()) {
    const path = join(root, ...entry.path.split("/"));
    if (entry.type === "symlink") await lchown(path, uid, gid);
    else {
      await chown(path, uid, gid);
      await chmod(path, entry.mode);
    }
  }
  await chown(root, uid, gid);
}
function restoredShape(entries: readonly CheckpointEntry[]): string {
  return encode(
    entries.map((entry) =>
      entry.type === "file"
        ? {
            path: entry.path,
            type: entry.type,
            mode: entry.mode,
            size: entry.size,
            sha256: entry.sha256,
          }
        : entry,
    ),
  );
}
async function assertRestoredWorkspace(
  root: string,
  entries: readonly CheckpointEntry[],
  agentId: string,
): Promise<void> {
  if (restoredShape(await inventoryWorkspace(root)) !== restoredShape(entries))
    throw new Error(`Completed restore workspace changed: ${agentId}`);
}
async function assertRestoredDatabase(path: string, manifest: CheckpointManifest): Promise<void> {
  const actual = await inventoryRegularFile(path),
    expected = manifest.database;
  if (
    actual.size !== expected.size ||
    actual.sha256 !== expected.sha256 ||
    actual.mode !== expected.mode
  )
    throw new Error("Completed restored database changed");
}

async function managedRestore(
  targetConfig: DaemonConfig,
  currentConfig: DaemonConfig,
  checkpointPath: string,
  options: RestoreTestingOptions,
): Promise<void> {
  const checkpointOwnerUid = options.checkpointOwnerUid ?? 0,
    checkpointOwnerGid = options.checkpointOwnerGid ?? process.getgid?.() ?? 0,
    target = await verifyCheckpoint(checkpointPath, targetConfig, {
      requiredOwnerUid: checkpointOwnerUid,
      requiredOwnerGid: checkpointOwnerGid,
    }),
    dataDir = resolve(currentConfig.runtime.dataDir);
  if (resolve(targetConfig.runtime.dataDir) !== dataDir)
    throw new Error("Managed restore configurations require the same data directory");
  const state = join(dataDir, "state"),
    control = join(dataDir, "control");
  for (const path of [dataDir, state, control]) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== resolve(path))
      throw new Error("Managed restore control paths must be existing canonical directories");
  }
  const release = acquireLock(join(state, "daemon.lock")),
    journalPath = join(control, "restore.json");
  try {
    await removeNamedTemps(control, ".restore-");
    let journal = await readJournal(journalPath);
    if (journal?.phase === "decided") await removeNamedTemps(state, ".mate.sqlite.restore-");
    const linuxUsers = currentConfig.runtime.linuxUsers;
    if (!linuxUsers) throw new Error("Restore requires Agent Linux users");
    const roots = new Map<string, string>();
    for (const agent of currentConfig.mate.agents) {
      const root = linuxUsers[agent.id]?.home;
      if (!root) throw new Error(`Linux Agent home missing: ${agent.id}`);
      roots.set(agent.id, root);
    }
    const assertBoundary = () => {
      for (const [agentId, root] of roots) {
        const identity = linuxUsers[agentId]!,
          stat = lstatSync(root);
        if (
          realpathSync(root) !== resolve(root) ||
          !stat.isDirectory() ||
          stat.uid !== identity.uid ||
          stat.gid !== identity.gid ||
          (stat.mode & 0o777) !== 0o700
        )
          throw new Error(`Linux private home boundary changed: ${agentId}`);
      }
    };
    const assertOutside = (checkpoint: VerifiedCheckpoint) => {
      for (const protectedRoot of [
        dataDir,
        ...roots.values(),
        ...(currentConfig.runtime.sharedRoot ? [currentConfig.runtime.sharedRoot] : []),
      ])
        if (within(protectedRoot, checkpoint.root) || within(checkpoint.root, protectedRoot))
          throw new Error("Checkpoint source must be outside live data and Agent workspaces");
    };
    assertOutside(target);
    assertBoundary();
    for (const [agentId, root] of roots) {
      const filesystem = statfsSync(root);
      const current = await inventoryWorkspace(root),
        reclaim = current.reduce(
          (total, entry) =>
            total +
            (entry.type === "file" ? BigInt(entry.allocatedBytes) : BigInt(filesystem.bsize)),
          0n,
        ),
        available = BigInt(filesystem.bavail) * BigInt(filesystem.bsize) + reclaim,
        availableInodes = BigInt(filesystem.ffree + current.length);
      if (
        requiredBytes(agentManifest(target.manifest, agentId).entries, filesystem.bsize) >
          available ||
        BigInt(agentManifest(target.manifest, agentId).entries.length + 8) > availableInodes
      )
        throw new Error(`Checkpoint cannot fit private workspace capacity: ${agentId}`);
    }
    const databasePath = join(state, "mate.sqlite");
    let databaseAlreadyRestored = false;
    if (journal?.phase === "decided" && !journal.databaseComplete && (await exists(databasePath))) {
      try {
        await assertRestoredDatabase(databasePath, target.manifest);
        databaseAlreadyRestored = true;
      } catch {
        /* The database still needs its atomic replacement. */
      }
    }
    if (!journal?.databaseComplete && !databaseAlreadyRestored) {
      const stateFilesystem = statfsSync(state),
        databasePayload = Math.max(
          target.manifest.database.size,
          target.manifest.database.allocatedBytes,
        ),
        databaseBytes =
          ((BigInt(databasePayload) + BigInt(stateFilesystem.bsize) - 1n) /
            BigInt(stateFilesystem.bsize)) *
          BigInt(stateFilesystem.bsize);
      if (
        databaseBytes + 1024n * 1024n >
          BigInt(stateFilesystem.bavail) * BigInt(stateFilesystem.bsize) ||
        stateFilesystem.ffree < 2
      )
        throw new Error("Checkpoint database cannot fit state filesystem capacity");
    }
    if (journal) {
      if (
        journal.configurationHash !== target.manifest.configurationHash ||
        !identityEqual(journal.target, target.identity)
      )
        throw new Error("Restore journal is bound to a different or replaced checkpoint");
      if (journal.current && journal.phase === "planned") {
        const current = await verifyCheckpoint(journal.current.path, currentConfig, {
          requiredOwnerUid: checkpointOwnerUid,
          requiredOwnerGid: checkpointOwnerGid,
        });
        assertOutside(current);
        if (!identityEqual(current.identity, journal.current))
          throw new Error("Restore journal current-state checkpoint was replaced");
        await assertLiveMatches(current, roots, dataDir);
      }
      if (
        journal.completedAgents.some(
          (agentId, index) => target.manifest.agents[index]?.agentId !== agentId,
        )
      )
        throw new Error("Restore journal Agent completion order is invalid");
    } else {
      const hasCurrent =
        (await exists(join(state, "mate.sqlite"))) ||
        (await Promise.all([...roots.values()].map(nonempty)).then((values) =>
          values.some(Boolean),
        ));
      let current: VerifiedCheckpoint | undefined;
      if (hasCurrent) {
        if (!options.currentCheckpoint)
          throw new Error("Replacing nonempty state requires its verified current checkpoint");
        current = await verifyCheckpoint(options.currentCheckpoint, currentConfig, {
          requiredOwnerUid: checkpointOwnerUid,
          requiredOwnerGid: checkpointOwnerGid,
        });
        assertOutside(current);
        await assertLiveMatches(current, roots, dataDir);
      }
      journal = {
        version: 1,
        phase: "planned",
        configurationHash: target.manifest.configurationHash,
        target: target.identity,
        ...(current ? { current: current.identity } : {}),
        completedAgents: [],
        databaseComplete: false,
      };
      await atomicJson(journalPath, journal);
      journal = { ...journal, phase: "decided" };
      await atomicJson(journalPath, journal);
      await options.afterPhase?.("decision");
    }
    if (journal.phase === "planned") {
      journal = { ...journal, phase: "decided" };
      await atomicJson(journalPath, journal);
      await options.afterPhase?.("decision");
    }
    // Re-verify every payload and the bound inode/hash after the durable decision before any destructive step.
    const source = await verifyCheckpoint(journal.target.path, targetConfig, {
      requiredOwnerUid: checkpointOwnerUid,
      requiredOwnerGid: checkpointOwnerGid,
    });
    if (!identityEqual(source.identity, journal.target))
      throw new Error("Restore checkpoint changed after decision");
    for (const agent of source.manifest.agents) {
      assertBoundary();
      const root = roots.get(agent.agentId)!;
      if (journal.completedAgents.includes(agent.agentId))
        await assertRestoredWorkspace(root, agent.entries, agent.agentId);
      else {
        await restoreWorkspace(source.root, agent.agentId, root, agent.entries);
        const identity = linuxUsers[agent.agentId]!;
        await restoreLinuxOwnership(root, identity.uid, identity.gid, agent.entries);
        assertBoundary();
        await assertRestoredWorkspace(root, agent.entries, agent.agentId);
        journal = { ...journal, completedAgents: [...journal.completedAgents, agent.agentId] };
        await atomicJson(journalPath, journal);
        await options.afterPhase?.(`agent:${agent.agentId}`);
      }
    }
    if (journal.databaseComplete) await assertRestoredDatabase(databasePath, source.manifest);
    else if (databaseAlreadyRestored) {
      journal = { ...journal, databaseComplete: true };
      await atomicJson(journalPath, journal);
    } else {
      await rm(`${databasePath}-wal`, { force: true });
      await rm(`${databasePath}-shm`, { force: true });
      await removeNamedTemps(state, ".mate.sqlite.restore-");
      await fsyncDirectory(state);
      await restoreRegularFile(
        join(source.root, "mate.sqlite"),
        databasePath,
        source.manifest.database,
      );
      await assertRestoredDatabase(databasePath, source.manifest);
      journal = { ...journal, databaseComplete: true };
      await atomicJson(journalPath, journal);
      await options.afterPhase?.("database");
    }
    if (!options.retainJournal) {
      await rm(journalPath);
      await fsyncDirectory(control);
    }
  } finally {
    release();
  }
}

async function restore(
  config: DaemonConfig,
  checkpoint: string,
  options: RestoreTestingOptions,
): Promise<void> {
  if (!config.runtime.linuxUsers) throw new Error("Restore requires Agent Linux users");
  await managedRestore(config, config, checkpoint, options);
}

export async function restoreCheckpoint(
  config: DaemonConfig,
  checkpoint: string,
  options: RestoreOptions = {},
): Promise<void> {
  if (linuxUpgradeInProgress(config))
    throw new Error("Ordinary restore is blocked while a Linux upgrade is pending");
  return restore(config, checkpoint, options);
}

/** Test-only ownership seam; production callers must use restoreCheckpoint's root-owned checkpoint contract. */
export async function restoreCheckpointForTesting(
  config: DaemonConfig,
  checkpoint: string,
  options: RestoreTestingOptions = {},
): Promise<void> {
  if (!process.env.VITEST) throw new Error("Checkpoint ownership overrides are test-only");
  return restore(config, checkpoint, options);
}

/** Read-only, content-free recovery status; uses the same parser as restore. */
export async function restoreProgress(dataDir: string) {
  const journal = await readJournal(join(dataDir, "control", "restore.json"));
  return journal
    ? {
        phase: journal.phase,
        databaseComplete: journal.databaseComplete,
        completedAgents: journal.completedAgents.length,
      }
    : null;
}
