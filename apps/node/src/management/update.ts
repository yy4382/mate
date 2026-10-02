import { nodePaths } from "./paths.js";
import {
  installedEntryVersion,
  installBundleFiles,
  preflightDirectory,
  prepareManagedDirectory,
  publishManagementEntry,
  recoverInstallationStaging,
  requireOrdinaryAccount,
  withManagementLock,
} from "./install-entry.js";
import {
  readManagedUnit,
  recoverUnitStaging,
  interruptedUnitFiles,
  publishNodeUnit,
  serviceReferencesBundle,
} from "./service.js";
import { systemdUserManager, type ServiceFacts } from "./systemd.js";
import { bundleRequest, withReleaseBundle } from "./acquire-bundle.js";
import { z } from "zod";
import { probeBundle, verifyBundle } from "./bundle.js";
import { dirname } from "node:path";
import { finishSameVersionRepair, prepareSameVersionRepair } from "./repair-bundle.js";

function assertStopped(facts: ServiceFacts) {
  if (
    !["inactive", "failed"].includes(facts.active) ||
    !["dead", "failed"].includes(facts.sub) ||
    facts.pid !== 0 ||
    facts.job !== 0
  )
    throw new Error(
      "Node service must be stopped with no pending start/restart job; run mate node stop first",
    );
}

/** Whole-bundle update command; manager replacements cover only early error branches. */
export async function updateNode(
  request: z.input<typeof bundleRequest>,
  paths = nodePaths(),
  manager = systemdUserManager,
) {
  requireOrdinaryAccount();
  bundleRequest.parse(request);
  manager.assertAvailable({ effectiveCommand: false });
  return withManagementLock(paths, async () => {
    const unitVersion = readManagedUnit(paths),
      previousUnits = interruptedUnitFiles(paths),
      selected = installedEntryVersion(paths);
    if (!unitVersion && !previousUnits.length)
      throw new Error("Mate user service is not installed; install it before updating");
    const inspectStopped = () => {
      const facts = manager.inspect({ effectiveCommand: false });
      if (facts.load !== "not-found" && facts.fragment !== paths.unit)
        throw new Error("Non-Mate manager unit conflicts with the installed service");
      assertStopped(facts);
      return facts;
    };
    const originalFacts = inspectStopped();
    for (const path of [dirname(paths.entry), paths.versionsDirectory, dirname(paths.unit)])
      preflightDirectory(path);
    return withReleaseBundle(request, async (directory) => {
      const metadata = verifyBundle(directory, request.version);
      probeBundle(directory, metadata);
      // No installed changes occur until acquisition, whole-file verification and native CLI preflight succeed.
      if (readManagedUnit(paths) !== unitVersion || installedEntryVersion(paths) !== selected)
        throw new Error("Installed references changed while acquiring; retry update");
      inspectStopped();
      recoverInstallationStaging(paths);
      recoverUnitStaging(paths, request.version);
      const repaired = prepareSameVersionRepair(paths, metadata);
      installBundleFiles(paths, directory, metadata);
      if (readManagedUnit(paths) !== unitVersion || installedEntryVersion(paths) !== selected)
        throw new Error("Installed references changed while staging; retry update");
      inspectStopped();
      prepareManagedDirectory(dirname(paths.entry));
      publishManagementEntry(paths, metadata.version, selected);
      try {
        // Entry/unit/reload are deliberately independent facts. A retry completes them while stopped.
        inspectStopped();
        if (readManagedUnit(paths) !== unitVersion)
          throw new Error("User unit changed concurrently; resolve the conflict before retrying");
        publishNodeUnit(paths, metadata.version, unitVersion, directory);
        manager.run("daemon-reload");
        const facts = manager.inspect();
        assertStopped(facts);
        if (
          facts.load !== "loaded" ||
          facts.fragment !== paths.unit ||
          facts.needsReload ||
          !serviceReferencesBundle(facts, paths, metadata.version)
        )
          throw new Error(
            "Effective service and complete bundle references differ; resolve the drop-in before retrying update",
          );
        if (facts.enabled !== originalFacts.enabled)
          throw new Error(
            "Service enabled/disabled state changed during update; inspect the actual user manager state",
          );
        finishSameVersionRepair(repaired, metadata);
        return `Mate complete bundle updated to ${metadata.version}\nEntry: ${paths.entry}\nUnit: ${paths.unit}\nActive: ${facts.active} (${facts.sub}); PID: ${facts.pid}; pending job: ${facts.job}\nEnabled: ${facts.enabled}\nConfiguration and node identity/data/workspaces were preserved. The executing CLI's old complete bundle was retained. Start the same-version control plane, then run mate node start explicitly.\n`;
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : "Update failed"}\nUpdate references may be incomplete. Keep node stopped; inspect mate node status/logs and retry the same mate node update command from this CLI or a verified local complete bundle. No rollback or automatic start was performed.`,
        );
      }
    });
  });
}
