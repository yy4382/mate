import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { within } from "../execution/paths.js";
import type { Store } from "../storage/store.js";
import type { DaemonConfig } from "./config.js";
import type { HostOperations } from "../deployment/host.js";
import {
  configurationHash,
  copyWorkspace,
  inventoryRegularFile,
  publishCheckpoint,
  type CheckpointManifest,
} from "./checkpoint-format.js";
async function backupDatabase(
  host: HostOperations,
  database: Database.Database,
  dataDir: string,
  destination: string,
  config: DaemonConfig,
  requireIdle: boolean,
): Promise<void> {
  if (resolve(dataDir) !== resolve(config.runtime.dataDir))
    throw new Error("Backup data directory must match configuration");
  const dataStat = await host.lstat(dataDir);
  if (!dataStat.isDirectory() || dataStat.isSymbolicLink())
    throw new Error("Backup data directory must be a directory, not a symlink");
  const liveDatabasePath = join(dataDir, "state", "mate.sqlite");
  if ((await host.canonical(database.name)) !== (await host.canonical(liveDatabasePath)))
    throw new Error("Backup connection must own the configured live database");
  const requested = resolve(destination),
    parent = await host.canonical(dirname(requested)),
    final = join(parent, basename(requested));
  const dataRoot = await host.canonical(dataDir),
    otherRoots = await Promise.all(
      [
        ...Object.values(config.runtime.linuxUsers ?? {}).map((user) => user.home),
        ...(config.runtime.sharedRoot ? [config.runtime.sharedRoot] : []),
      ].map((root) => host.canonical(root)),
    );
  if (
    within(dataRoot, final) ||
    within(final, dataRoot) ||
    otherRoots.some((root) => within(root, final) || within(final, root))
  )
    throw new Error("Backup destination must be outside live data and Agent workspaces");
  try {
    const existing = await host.lstat(final);
    if (!existing.isDirectory() || existing.isSymbolicLink() || (await host.readdir(final)).length)
      throw new Error("Checkpoint destination must be absent or one empty directory");
    if ((await host.canonical(final)) !== final)
      throw new Error("Checkpoint destination must be canonical");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await host.mkdir(final, 0o700);
  }
  if (
    requireIdle &&
    (database.prepare("SELECT 1 FROM runs WHERE state='active'").get() ||
      database.prepare("SELECT 1 FROM actions WHERE state='executing'").get())
  )
    throw new Error("Backup requires idle workers and executors");
  database.pragma("wal_checkpoint(TRUNCATE)");
  const liveDatabase = await inventoryRegularFile(host, liveDatabasePath),
    wal = `${liveDatabasePath}-wal`;
  try {
    if ((await host.lstat(wal)).size)
      throw new Error("Backup database WAL changed after checkpoint");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  {
    const staging = final;
    const agentsDir = join(staging, "agents");
    await host.mkdir(agentsDir, 0o700);
    const agents = [];
    for (const agentId of config.mate.agents.map((agent) => agent.id).sort())
      agents.push({
        agentId,
        entries: await copyWorkspace(
          host,
          config.runtime.linuxUsers?.[agentId]?.home ?? join(dataDir, "agents", agentId),
          join(agentsDir, agentId),
        ),
      });
    const databasePath = join(staging, "mate.sqlite");
    await database.backup(databasePath);
    const details = await inventoryRegularFile(host, databasePath);
    const databaseEntry: CheckpointManifest["database"] = {
      path: "mate.sqlite",
      ...details,
      sourceSha256: liveDatabase.sha256,
    };
    const manifest: CheckpointManifest = {
      version: 2,
      dataDir: resolve(dataDir),
      at: new Date().toISOString(),
      configurationHash: configurationHash(config),
      agents,
      database: databaseEntry,
    };
    await publishCheckpoint(host, staging, manifest);
  }
}

/** Caller stops scheduling and waits for workers/executors to settle before taking this checkpoint. */
export async function backup(
  host: HostOperations,
  store: Store,
  dataDir: string,
  destination: string,
  config: DaemonConfig,
): Promise<void> {
  return backupDatabase(host, store.db, dataDir, destination, config, true);
}

/** Recovery snapshot which never constructs Store, so checkpointing a stopped deployment cannot open its database for writing. Caller holds the daemon lock and has stopped/recovered the execution scope. */
export async function backupDeploymentSnapshot(
  host: HostOperations,
  dataDir: string,
  destination: string,
  config: DaemonConfig,
): Promise<void> {
  const database = new Database(join(dataDir, "state", "mate.sqlite"), {
    fileMustExist: true,
  });
  try {
    database.pragma("busy_timeout = 5000");
    await backupDatabase(host, database, dataDir, destination, config, false);
  } finally {
    database.close();
  }
}
