import {
  createCoordinatedCheckpoint,
  restoreCoordinatedCheckpoint,
  type CheckpointManifest,
  type CoordinatedStatePaths,
} from "./coordinated-checkpoint.js";

export interface CoordinatedMaintenanceServices {
  /**
   * Stop the services the maintenance must not run against and prove they are gone. A stop that
   * cannot be confirmed must throw: a checkpoint taken while operations are still live is not a
   * recovery point. Returning a report is allowed, and is ignored.
   */
  stop(): void | Promise<unknown>;
  /** Restore the service state captured before stop(). */
  resume(): void | Promise<unknown>;
}

/** Make a checkpoint only while quiesced, then restore the prior service state. */
export async function createMaintenanceBackup(
  paths: CoordinatedStatePaths,
  destination: string,
  services: CoordinatedMaintenanceServices,
): Promise<CheckpointManifest> {
  let stopped = false;
  let manifest: CheckpointManifest;
  try {
    manifest = await createCoordinatedCheckpoint(paths, destination, async () => {
      await stopWithRecovery(services);
      stopped = true;
    });
  } catch (error) {
    if (stopped) await resumeAfterBackupFailure(services, error);
    throw error;
  }
  if (stopped) await resumeOrStop(services);
  return manifest;
}

/** A restore stays stopped and fenced on failure; service startup follows reconciliation. */
export async function restoreMaintenanceCheckpoint<T>(
  checkpoint: string,
  paths: CoordinatedStatePaths,
  services: CoordinatedMaintenanceServices,
  reconcile: () => Promise<T> | T,
): Promise<T> {
  let report!: T;
  await restoreCoordinatedCheckpoint(
    checkpoint,
    paths,
    async () => stopWithRecovery(services),
    async () => {
      report = await reconcile();
    },
  );
  await resumeOrStop(services);
  return report;
}

/** Recheck all local Agent identities and receipts before resuming after manual repair. */
export async function reconcileDuringMaintenance<T>(
  services: CoordinatedMaintenanceServices,
  reconcile: () => T,
): Promise<T> {
  await stopWithRecovery(services);
  const report = reconcile();
  await resumeOrStop(services);
  return report;
}

/** Never run an upgrade callback when creation of its recovery point failed. */
export async function upgradeAfterCheckpoint<T>(
  checkpoint: () => Promise<CheckpointManifest>,
  upgrade: () => T,
): Promise<{ manifest: CheckpointManifest; result: T }> {
  const manifest = await checkpoint();
  const result = upgrade();
  return { manifest, result };
}

/** Keep services stopped across the version switch; an incomplete checkpoint cannot install. */
export async function upgradeWithCoordinatedCheckpoint<T>(
  paths: CoordinatedStatePaths,
  destination: string,
  services: CoordinatedMaintenanceServices,
  upgrade: () => T,
): Promise<{ manifest: CheckpointManifest; result: T }> {
  await stopWithRecovery(services);
  let manifest: CheckpointManifest;
  try {
    manifest = await createCoordinatedCheckpoint(paths, destination, async () => {});
  } catch (error) {
    // Never returns; the old service state is restored first.
    await resumeAfterBackupFailure(services, error);
    throw error;
  }
  return { manifest, result: upgrade() };
}

/** A release command is a fresh verification request, not an override for a recovery hold. */
export async function releaseAgentAfterReconciliation<
  T extends {
    released: string[];
    holds: Array<{ agentId: string; reason: string }>;
  },
>(agentId: string, reconcile: () => Promise<T> | T): Promise<T> {
  const report = await reconcile();
  if (!report.released.includes(agentId)) {
    const reason =
      report.holds.find((hold) => hold.agentId === agentId)?.reason ??
      "agent is not verified as a local recoverable identity";
    throw new Error(`Agent ${agentId} remains held: ${reason}`);
  }
  return report;
}

async function resumeOrStop(services: CoordinatedMaintenanceServices): Promise<void> {
  try {
    await services.resume();
  } catch (startError) {
    try {
      await services.stop();
    } catch (stopError) {
      throw new AggregateError(
        [startError, stopError],
        "Service restart failed and stop was incomplete",
      );
    }
    throw startError;
  }
}

/** A failed stop may already have stopped one service; recover to a known state. */
async function stopWithRecovery(services: CoordinatedMaintenanceServices): Promise<void> {
  try {
    await services.stop();
  } catch (stopError) {
    try {
      await services.resume();
    } catch (resumeError) {
      try {
        await services.stop();
      } catch (retryStopError) {
        throw new AggregateError(
          [stopError, resumeError, retryStopError],
          "Maintenance stop failed and service state could not be confirmed",
        );
      }
      throw new AggregateError(
        [stopError, resumeError],
        "Maintenance stop failed; services are stopped for diagnosis",
      );
    }
    throw stopError;
  }
}

async function resumeAfterBackupFailure(
  services: CoordinatedMaintenanceServices,
  originalError: unknown,
): Promise<never> {
  try {
    await services.resume();
  } catch (resumeError) {
    try {
      await services.stop();
    } catch (stopError) {
      throw new AggregateError(
        [originalError, resumeError, stopError],
        "Backup failed and service recovery was incomplete",
      );
    }
    throw new AggregateError(
      [originalError, resumeError],
      "Backup failed and services remain stopped",
    );
  }
  throw originalError;
}
