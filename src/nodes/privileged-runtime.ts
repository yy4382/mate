import { chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { openNodeProcessDatabase } from "../storage/initialize.js";
import { PrivilegedBackend } from "../execution/privileged.js";
import { PrivilegedNodeOperations } from "./privileged-operations.js";

/** The node service owns this root-only durable receipt database. */
export function openNodePrivilegedOperations(
  dataDirectory: string,
  nodeId: string,
): {
  operations: PrivilegedNodeOperations;
  close(): void;
} {
  const path = join(dataDirectory, "privileged-operations.sqlite");
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error("Privileged receipt database must be a private regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const database = openNodeProcessDatabase(path);
  chmodSync(path, 0o600);
  try {
    const backend = new PrivilegedBackend();
    const operations = new PrivilegedNodeOperations(database, nodeId, "", (command) =>
      backend.execute({ program: command.program, args: command.args, cwd: command.cwd }),
    );
    return { operations, close: () => database.close() };
  } catch (error) {
    database.close();
    throw error;
  }
}
