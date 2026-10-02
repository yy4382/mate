import { homedir } from "node:os";
import { join } from "node:path";

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
    dataDirectory: join(home, ".local/share/mate/node"),
  };
}
