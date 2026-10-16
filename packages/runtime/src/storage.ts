import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteStorage, type SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

export type DatabaseWrapper = (database: SqliteDatabase) => SqliteDatabase;

/** Raised when an Agent's store is opened but its file does not exist: the Agent does not exist. */
export class AgentStoreMissing extends Error {
  readonly file: string;

  constructor(file: string) {
    super(`Agent store does not exist: ${file}`);
    this.file = file;
  }
}

/**
 * Open the Durable storage in one Agent's file. WAL with `synchronous=FULL`, so a committed step survives power loss,
 * not only a process crash. The file is private to the account.
 */
export async function openAgentStorage(
  file: string,
  wrap: DatabaseWrapper | undefined,
  guard: DatabaseWrapper,
): Promise<{ storage: SqliteStorage; database: SqliteDatabase }> {
  if (!existsSync(file)) throw new AgentStoreMissing(file);
  return openStorage(file, wrap, guard);
}

/**
 * Initialize a new Agent store at `file`. The store is built under a temporary name and renamed into place last, so a
 * crash leaves either a complete store or none.
 */
export async function createAgentStorage(
  file: string,
  initialize: (storage: SqliteStorage) => Promise<void>,
): Promise<void> {
  if (existsSync(file)) throw new Error(`Agent store already exists: ${file}`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const staging = `${file}.creating`;
  for (const leftover of [staging, `${staging}-wal`, `${staging}-shm`])
    rmSync(leftover, { force: true });
  await initialize((await openStorage(staging, undefined)).storage);
  renameSync(staging, file);
}

async function openStorage(
  file: string,
  wrap: DatabaseWrapper | undefined,
  guard?: DatabaseWrapper,
) {
  const opened = await openNodeSqliteDatabase(file);
  chmodSync(file, 0o600);
  await opened.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  const database = wrap === undefined ? opened : wrap(opened);
  return {
    storage: await SqliteStorage.open(guard === undefined ? database : guard(database)),
    database,
  };
}
