import type { DaemonConfig } from "../daemon/config.js";
import { linuxUpgradeJournalPath, readLinuxUpgradeJournal } from "./linux-installer.js";
import { managedLayout } from "./systemd.js";
import { pathExists, type HostOperations } from "./host.js";

export type LinuxOperation = "start" | "offline-probe" | "backup" | "restore";

export async function assertLinuxOperationAllowed(
  host: HostOperations,
  operation: LinuxOperation,
  config: DaemonConfig,
): Promise<void> {
  if (!config.runtime.linuxUsers) return;
  const path = linuxUpgradeJournalPath(config.runtime.dataDir);
  if (!(await pathExists(host, path))) return;
  const journal = await readLinuxUpgradeJournal(host, path);
  if (operation === "start" || operation === "offline-probe") {
    if ((await host.canonical(managedLayout.current)) !== journal.newRelease)
      throw new Error("Current release differs from pending Linux upgrade");
    return;
  }
  throw new Error(`Pending Linux upgrade blocks ${operation}; finalize or roll back first`);
}

export async function linuxUpgradeInProgress(
  host: HostOperations,
  config: DaemonConfig,
): Promise<boolean> {
  if (!config.runtime.linuxUsers) return false;
  const path = linuxUpgradeJournalPath(config.runtime.dataDir);
  if (!(await pathExists(host, path))) return false;
  await readLinuxUpgradeJournal(host, path);
  return true;
}
