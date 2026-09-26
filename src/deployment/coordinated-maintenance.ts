import {
  createCoordinatedCheckpoint,
  restoreCoordinatedCheckpoint,
  type CheckpointManifest,
  type CoordinatedStatePaths,
} from "./coordinated-checkpoint.js";

export interface CoordinatedMaintenanceServices {
  /** Stop both services and prove every managed Agent process has exited. */
  stop(): void;
  /** Restore the active service state captured before stop(). */
  resume(): void;
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
      services.stop();
      stopped = true;
    });
  } catch (error) {
    if (stopped) resumeAfterBackupFailure(services, error);
    throw error;
  }
  if (stopped) resumeOrStop(services);
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
    async () => services.stop(),
    async () => {
      report = await reconcile();
    },
  );
  resumeOrStop(services);
  return report;
}

/** Recheck all local Agent identities and receipts before resuming after manual repair. */
export function reconcileDuringMaintenance<T>(
  services: CoordinatedMaintenanceServices,
  reconcile: () => T,
): T {
  services.stop();
  const report = reconcile();
  resumeOrStop(services);
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
  services.stop();
  let manifest: CheckpointManifest;
  try {
    manifest = await createCoordinatedCheckpoint(paths, destination, async () => {});
  } catch (error) {
    resumeAfterBackupFailure(services, error);
  }
  return { manifest, result: upgrade() };
}

/** A release command is a fresh verification request, not an override for a recovery hold. */
export function releaseAgentAfterReconciliation<
  T extends {
    released: string[];
    holds: Array<{ agentId: string; reason: string }>;
  },
>(agentId: string, reconcile: () => T): T {
  const report = reconcile();
  if (!report.released.includes(agentId)) {
    const reason =
      report.holds.find((hold) => hold.agentId === agentId)?.reason ??
      "agent is not verified as a local recoverable identity";
    throw new Error(`Agent ${agentId} remains held: ${reason}`);
  }
  return report;
}

function resumeOrStop(services: CoordinatedMaintenanceServices): void {
  try {
    services.resume();
  } catch (startError) {
    try {
      services.stop();
    } catch (stopError) {
      throw new AggregateError(
        [startError, stopError],
        "Service restart failed and stop was incomplete",
      );
    }
    throw startError;
  }
}

function resumeAfterBackupFailure(
  services: CoordinatedMaintenanceServices,
  originalError: unknown,
): never {
  try {
    services.resume();
  } catch (resumeError) {
    try {
      services.stop();
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
