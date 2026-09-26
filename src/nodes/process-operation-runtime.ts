import Database from "better-sqlite3";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createLinuxAgentProcessExecutor } from "./linux-process-executor.js";
import { AgentProcessOperations } from "./process-operations.js";

/** Open private, durable node-side operation receipts under the node service data directory. */
export function openNodeProcessOperations(
  dataDirectory: string,
  agentHomeRoot: string,
): { operations: AgentProcessOperations; close(): void } {
  if (!isAbsolute(dataDirectory)) throw new Error("Node data directory must be absolute");
  const directory = resolve(dataDirectory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (directoryStat.mode & 0o077) !== 0
  )
    throw new Error("Node operation data directory must be a private real directory");

  const databasePath = join(directory, "agent-process-operations.sqlite");
  let existed = true;
  try {
    const file = lstatSync(databasePath);
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0)
      throw new Error("Node operation receipt database must be a private regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existed = false;
  }

  const database = new Database(databasePath);
  try {
    if (!existed) chmodSync(databasePath, 0o600);
    database.pragma("journal_mode = DELETE");
    database.pragma("synchronous = FULL");
    const operations = new AgentProcessOperations(
      database,
      createLinuxAgentProcessExecutor(agentHomeRoot),
    );
    return { operations, close: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
}
