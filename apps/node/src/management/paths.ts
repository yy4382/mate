import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** All managed paths belong to the existing account; no system paths or identities. */
export function nodePaths(home = homedir()) {
  const programDirectory = join(home, ".local/lib/mate-node");
  return {
    home,
    programDirectory,
    versionsDirectory: join(programDirectory, "versions"),
    entry: join(home, ".local/bin/mate"),
    unit: join(home, ".config/systemd/user/mate-node.service"),
    configDirectory: join(home, ".config/mate"),
    configuration: join(home, ".config/mate/node.json"),
    dataDirectory: join(home, ".local/share/mate/node"),
  };
}

export function lstatIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Resolve the existing ancestor while retaining any missing path segments. */
export function canonicalManagedPath(path: string) {
  let ancestor = resolve(path);
  const missing = [];
  while (!lstatIfPresent(ancestor)) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return join(realpathSync(ancestor), ...missing);
}
