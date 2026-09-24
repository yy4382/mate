import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { DaemonConfig } from "../daemon/config.js";
import { readLinuxUpgradeJournal } from "./linux-installer.js";
import { managedLayout } from "./systemd.js";

export type LinuxOperation = "start" | "offline-probe" | "backup" | "restore";

export function assertLinuxOperationAllowed(operation: LinuxOperation, config: DaemonConfig): void {
  if (!config.runtime.linuxUsers) return;
  const path = join(config.runtime.dataDir, "control", "linux-upgrade.json");
  if (!existsSync(path)) return;
  const journal = readLinuxUpgradeJournal(path);
  if (operation === "start" || operation === "offline-probe") {
    if (realpathSync(managedLayout.current) !== journal.newRelease)
      throw new Error("Current release differs from pending Linux upgrade");
    return;
  }
  throw new Error(`Pending Linux upgrade blocks ${operation}; finalize or roll back first`);
}

export function linuxUpgradeInProgress(config: DaemonConfig): boolean {
  if (!config.runtime.linuxUsers) return false;
  const path = join(config.runtime.dataDir, "control", "linux-upgrade.json");
  if (!existsSync(path)) return false;
  readLinuxUpgradeJournal(path);
  return true;
}
