import { systemErrorCode } from "../system-error.js";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { openNodeProcessDatabase } from "./operation-database.js";
import {
  createLinuxAgentProcessExecutor,
  type LinuxAgentProcessExecutorOptions,
} from "./linux-process-executor.js";
import { AgentProcessOperations } from "./operation-ledger.js";

/** Open private, durable node-side operation receipts under the node service data directory. */
export function openNodeProcessOperations(
  dataDirectory: string,
  agentHomeRoot: string,
  executorOptions: LinuxAgentProcessExecutorOptions = {},
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
    if (systemErrorCode(error) !== "ENOENT") throw error;
    existed = false;
  }

  const database = openNodeProcessDatabase(databasePath);
  try {
    if (!existed) chmodSync(databasePath, 0o600);
    const operations = new AgentProcessOperations(
      database,
      createLinuxAgentProcessExecutor(agentHomeRoot, executorOptions),
    );
    return { operations, close: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
}
