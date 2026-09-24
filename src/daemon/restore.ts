import { randomUUID } from "node:crypto";
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
import { assertManagedEntry, hostRules, type AgentEntries } from "../deployment/host-rules.js";
import { pathExists, type HostOperations } from "../deployment/host.js";
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
async function atomicJson(host: HostOperations, path: string, value: unknown): Promise<void> {
  const parent = dirname(path),
    temporary = join(parent, `.restore-${randomUUID()}`),
    handle = await host.createExclusive(temporary, 0o600);
  let renamed = false;
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    await host.rename(temporary, path);
    renamed = true;
    await fsyncDirectory(host, parent);
  } finally {
    if (!renamed) {
      await handle.close().catch(() => {});
      await host.remove(temporary);
    }
  }
}
async function removeNamedTemps(
  host: HostOperations,
  directory: string,
  prefix: string,
): Promise<void> {
  for (const name of await host.readdir(directory))
    if (name.startsWith(prefix)) await host.remove(join(directory, name));
  await fsyncDirectory(host, directory);
}
async function readJournal(
  host: HostOperations,
  path: string,
): Promise<RestoreJournal | undefined> {
  if (!(await pathExists(host, path))) return undefined;
  const handle = await host.openForRead(path);
  try {
    return journalSchema.parse(JSON.parse((await handle.readFile()).toString("utf8")));
  } finally {
    await handle.close();
  }
}
export async function assertNoRestoreInProgress(
  host: HostOperations,
  dataDir: string,
): Promise<void> {
  const control = join(dataDir, "control");
  if (await pathExists(host, control)) {
    const stat = await host.lstat(control);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Restore control path must be a directory");
  }
  if (await pathExists(host, join(control, "restore.json")))
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
async function nonempty(host: HostOperations, path: string): Promise<boolean> {
  if (!(await pathExists(host, path))) return false;
  return (await host.readdir(path)).some((name) => name !== "lost+found");
}
async function assertLiveMatches(
  host: HostOperations,
  checkpoint: VerifiedCheckpoint,
  roots: ReadonlyMap<string, string>,
  dataDir: string,
): Promise<void> {
  const databasePath = join(dataDir, "state", "mate.sqlite");
  if (!(await pathExists(host, databasePath)))
    throw new Error("Current state checkpoint does not match the live database");
  const actual = await inventoryRegularFile(host, databasePath),
    wal = `${databasePath}-wal`;
  if (
    actual.sha256 !== checkpoint.manifest.database.sourceSha256 ||
    ((await pathExists(host, wal)) && (await host.lstat(wal)).size > 0)
  )
    throw new Error("Current state checkpoint does not match the live database");
  for (const [agentId, root] of roots) {
    if (
      !(await pathExists(host, root)) ||
      encode(await inventoryWorkspace(host, root)) !==
        encode(agentManifest(checkpoint.manifest, agentId).entries)
    )
      throw new Error(`Current state checkpoint does not match live workspace: ${agentId}`);
  }
}
async function clearWorkspace(host: HostOperations, root: string): Promise<void> {
  for (const name of await host.readdir(root))
    if (name !== "lost+found") await host.remove(join(root, name), { recursive: true });
  await fsyncDirectory(host, root);
}
async function restoreWorkspace(
  host: HostOperations,
  checkpointRoot: string,
  agentId: string,
  root: string,
  entries: readonly CheckpointEntry[],
): Promise<void> {
  const rootStat = await host.lstat(root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (await host.canonical(root)) !== resolve(root)
  )
    throw new Error("Private workspace mount disappeared before restore");
  await clearWorkspace(host, root);
  const sourceRoot = join(checkpointRoot, "agents", agentId);
  for (const entry of entries) {
    const destination = join(root, ...entry.path.split("/"));
    if (entry.type === "directory") await host.mkdir(destination, 0o700);
    else if (entry.type === "file")
      await restoreRegularFile(
        host,
        join(sourceRoot, ...entry.path.split("/")),
        destination,
        entry,
      );
    else {
      const temporary = `${destination}.restore-${randomUUID()}`;
      await host.symlink(entry.target, temporary);
      await host.rename(temporary, destination);
      await fsyncDirectory(host, dirname(destination));
    }
  }
  for (const entry of [...entries].reverse())
    if (entry.type === "directory") {
      await host.chmod(join(root, ...entry.path.split("/")), entry.mode);
      await fsyncDirectory(host, join(root, ...entry.path.split("/")));
    }
  await fsyncDirectory(host, root);
}
async function restoreLinuxOwnership(
  host: HostOperations,
  root: string,
  uid: number,
  gid: number,
  entries: readonly CheckpointEntry[],
): Promise<void> {
  for (const entry of [...entries].reverse()) {
    const path = join(root, ...entry.path.split("/"));
    if (entry.type === "symlink") await host.lchown(path, uid, gid);
    else {
      await host.chown(path, uid, gid);
      await host.chmod(path, entry.mode);
    }
  }
  await host.chown(root, uid, gid);
}
/** Post-restore verification keeps every recorded payload fact except allocation. */
function restoredShape(entry: CheckpointEntry): string {
  return entry.type === "file"
    ? encode({
        path: entry.path,
        type: entry.type,
        mode: entry.mode,
        size: entry.size,
        sha256: entry.sha256,
      })
    : encode(entry);
}
/**
 * Re-inventory a completed Agent root and compare it with the checkpoint: content, permissions and
 * file type (file, directory or symlink) must match, and every entry must belong to the Agent's
 * Linux identity. This re-verification is what makes an interrupted restore safe to resume.
 */
async function assertRestoredWorkspace(
  host: HostOperations,
  root: string,
  entries: readonly CheckpointEntry[],
  agentId: string,
  owner: { uid: number; gid: number },
): Promise<void> {
  const actual = await inventoryWorkspace(host, root);
  if (
    actual.length !== entries.length ||
    actual.some(
      (entry, index) =>
        entry.path !== entries[index]!.path ||
        entry.type !== entries[index]!.type ||
        restoredShape(entry) !== restoredShape(entries[index]!),
    )
  )
    throw new Error(`Completed restore workspace changed: ${agentId}`);
  for (const path of [root, ...entries.map((entry) => join(root, ...entry.path.split("/")))]) {
    const stat = await host.lstat(path);
    if (stat.uid !== owner.uid || stat.gid !== owner.gid)
      throw new Error(`Completed restore workspace ownership changed: ${agentId}`);
  }
}
async function assertRestoredDatabase(
  host: HostOperations,
  path: string,
  manifest: CheckpointManifest,
): Promise<void> {
  const actual = await inventoryRegularFile(host, path),
    expected = manifest.database;
  if (
    actual.size !== expected.size ||
    actual.sha256 !== expected.sha256 ||
    actual.mode !== expected.mode
  )
    throw new Error("Completed restored database changed");
}

async function managedRestore(
  host: HostOperations,
  targetConfig: DaemonConfig,
  currentConfig: DaemonConfig,
  checkpointPath: string,
  options: RestoreTestingOptions,
): Promise<void> {
  const checkpointOwnerUid = options.checkpointOwnerUid ?? 0,
    checkpointOwnerGid = options.checkpointOwnerGid ?? host.egid(),
    target = await verifyCheckpoint(host, checkpointPath, targetConfig, {
      requiredOwnerUid: checkpointOwnerUid,
      requiredOwnerGid: checkpointOwnerGid,
    }),
    dataDir = resolve(currentConfig.runtime.dataDir);
  if (resolve(targetConfig.runtime.dataDir) !== dataDir)
    throw new Error("Managed restore configurations require the same data directory");
  const rules = hostRules(currentConfig),
    state = join(dataDir, "state"),
    control = join(dataDir, "control");
  // The same managed-path rules that installation enforces guard the live control paths here.
  for (const entry of rules.restoreBoundary) await assertManagedEntry(host, entry, rules);
  const release = host.lockExclusive(join(state, "daemon.lock")),
    journalPath = join(control, "restore.json");
  const agents = new Map<string, AgentEntries>(
    rules.agents.map((agent) => [agent.identity.agentId, agent]),
  );
  try {
    await removeNamedTemps(host, control, ".restore-");
    let journal = await readJournal(host, journalPath);
    if (journal?.phase === "decided") await removeNamedTemps(host, state, ".mate.sqlite.restore-");
    const roots = new Map<string, string>();
    for (const agent of currentConfig.mate.agents) {
      const entry = agents.get(agent.id);
      if (!entry) throw new Error(`Linux Agent home missing: ${agent.id}`);
      roots.set(agent.id, entry.identity.home);
    }
    const assertBoundary = async () => {
      for (const entry of rules.restoreBoundary) await assertManagedEntry(host, entry, rules);
      for (const agent of agents.values()) await assertManagedEntry(host, agent.home, rules);
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
    await assertBoundary();
    for (const [agentId, root] of roots) {
      const filesystem = await host.filesystem(root),
        block = BigInt(filesystem.blockSize);
      const current = await inventoryWorkspace(host, root),
        reclaim = current.reduce(
          (total, entry) => total + (entry.type === "file" ? BigInt(entry.allocatedBytes) : block),
          0n,
        ),
        available = BigInt(filesystem.availableBlocks) * block + reclaim,
        availableInodes = BigInt(filesystem.freeInodes + current.length);
      if (
        requiredBytes(agentManifest(target.manifest, agentId).entries, filesystem.blockSize) >
          available ||
        BigInt(agentManifest(target.manifest, agentId).entries.length + 8) > availableInodes
      )
        throw new Error(`Checkpoint cannot fit private workspace capacity: ${agentId}`);
    }
    const databasePath = join(state, "mate.sqlite");
    let databaseAlreadyRestored = false;
    if (
      journal?.phase === "decided" &&
      !journal.databaseComplete &&
      (await pathExists(host, databasePath))
    ) {
      try {
        await assertRestoredDatabase(host, databasePath, target.manifest);
        databaseAlreadyRestored = true;
      } catch {
        /* The database still needs its atomic replacement. */
      }
    }
    if (!journal?.databaseComplete && !databaseAlreadyRestored) {
      const stateFilesystem = await host.filesystem(state),
        databasePayload = Math.max(
          target.manifest.database.size,
          target.manifest.database.allocatedBytes,
        ),
        databaseBytes =
          ((BigInt(databasePayload) + BigInt(stateFilesystem.blockSize) - 1n) /
            BigInt(stateFilesystem.blockSize)) *
          BigInt(stateFilesystem.blockSize);
      if (
        databaseBytes + 1024n * 1024n >
          BigInt(stateFilesystem.availableBlocks) * BigInt(stateFilesystem.blockSize) ||
        stateFilesystem.freeInodes < 2
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
        const current = await verifyCheckpoint(host, journal.current.path, currentConfig, {
          requiredOwnerUid: checkpointOwnerUid,
          requiredOwnerGid: checkpointOwnerGid,
        });
        assertOutside(current);
        if (!identityEqual(current.identity, journal.current))
          throw new Error("Restore journal current-state checkpoint was replaced");
        await assertLiveMatches(host, current, roots, dataDir);
      }
      if (
        journal.completedAgents.some(
          (agentId, index) => target.manifest.agents[index]?.agentId !== agentId,
        )
      )
        throw new Error("Restore journal Agent completion order is invalid");
    } else {
      const hasCurrent =
        (await pathExists(host, join(state, "mate.sqlite"))) ||
        (await Promise.all([...roots.values()].map((root) => nonempty(host, root)))).some(Boolean);
      let current: VerifiedCheckpoint | undefined;
      if (hasCurrent) {
        if (!options.currentCheckpoint)
          throw new Error("Replacing nonempty state requires its verified current checkpoint");
        current = await verifyCheckpoint(host, options.currentCheckpoint, currentConfig, {
          requiredOwnerUid: checkpointOwnerUid,
          requiredOwnerGid: checkpointOwnerGid,
        });
        assertOutside(current);
        await assertLiveMatches(host, current, roots, dataDir);
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
      await atomicJson(host, journalPath, journal);
      journal = { ...journal, phase: "decided" };
      await atomicJson(host, journalPath, journal);
      await options.afterPhase?.("decision");
    }
    if (journal.phase === "planned") {
      journal = { ...journal, phase: "decided" };
      await atomicJson(host, journalPath, journal);
      await options.afterPhase?.("decision");
    }
    // Re-verify every payload and the bound inode/hash after the durable decision before any destructive step.
    const source = await verifyCheckpoint(host, journal.target.path, targetConfig, {
      requiredOwnerUid: checkpointOwnerUid,
      requiredOwnerGid: checkpointOwnerGid,
    });
    if (!identityEqual(source.identity, journal.target))
      throw new Error("Restore checkpoint changed after decision");
    for (const agent of source.manifest.agents) {
      await assertBoundary();
      const identity = agents.get(agent.agentId)!.identity,
        root = roots.get(agent.agentId)!;
      if (journal.completedAgents.includes(agent.agentId))
        await assertRestoredWorkspace(host, root, agent.entries, agent.agentId, identity);
      else {
        await restoreWorkspace(host, source.root, agent.agentId, root, agent.entries);
        await restoreLinuxOwnership(host, root, identity.uid, identity.gid, agent.entries);
        await assertBoundary();
        await assertRestoredWorkspace(host, root, agent.entries, agent.agentId, identity);
        journal = {
          ...journal,
          completedAgents: [...journal.completedAgents, agent.agentId],
        };
        await atomicJson(host, journalPath, journal);
        await options.afterPhase?.(`agent:${agent.agentId}`);
      }
    }
    if (journal.databaseComplete) await assertRestoredDatabase(host, databasePath, source.manifest);
    else if (databaseAlreadyRestored) {
      journal = { ...journal, databaseComplete: true };
      await atomicJson(host, journalPath, journal);
    } else {
      await host.remove(`${databasePath}-wal`);
      await host.remove(`${databasePath}-shm`);
      await removeNamedTemps(host, state, ".mate.sqlite.restore-");
      await fsyncDirectory(host, state);
      await restoreRegularFile(
        host,
        join(source.root, "mate.sqlite"),
        databasePath,
        source.manifest.database,
      );
      await assertRestoredDatabase(host, databasePath, source.manifest);
      journal = { ...journal, databaseComplete: true };
      await atomicJson(host, journalPath, journal);
      await options.afterPhase?.("database");
    }
    if (!options.retainJournal) {
      await host.remove(journalPath, { force: false });
      await fsyncDirectory(host, control);
    }
  } finally {
    release();
  }
}

async function restore(
  host: HostOperations,
  config: DaemonConfig,
  checkpoint: string,
  options: RestoreTestingOptions,
): Promise<void> {
  if (!config.runtime.linuxUsers) throw new Error("Restore requires Agent Linux users");
  await managedRestore(host, config, config, checkpoint, options);
}

export async function restoreCheckpoint(
  host: HostOperations,
  config: DaemonConfig,
  checkpoint: string,
  options: RestoreOptions = {},
): Promise<void> {
  if (await linuxUpgradeInProgress(host, config))
    throw new Error("Ordinary restore is blocked while a Linux upgrade is pending");
  return restore(host, config, checkpoint, options);
}

/** Test-only ownership seam; production callers must use restoreCheckpoint's root-owned checkpoint contract. */
export async function restoreCheckpointForTesting(
  host: HostOperations,
  config: DaemonConfig,
  checkpoint: string,
  options: RestoreTestingOptions = {},
): Promise<void> {
  if (!process.env.VITEST) throw new Error("Checkpoint ownership overrides are test-only");
  return restore(host, config, checkpoint, options);
}

/** Read-only, content-free recovery status; uses the same parser as restore. */
export async function restoreProgress(host: HostOperations, dataDir: string) {
  const journal = await readJournal(host, join(dataDir, "control", "restore.json"));
  return journal
    ? {
        phase: journal.phase,
        databaseComplete: journal.databaseComplete,
        completedAgents: journal.completedAgents.length,
      }
    : null;
}
