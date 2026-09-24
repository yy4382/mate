import { join } from "node:path";
import Database from "better-sqlite3";
import { daemonConfigSchema, type DaemonConfig } from "../daemon/config.js";
import { restoreProgress } from "../daemon/restore.js";
import { ConfiguredAgents } from "../agents/directory.js";
import { OperationsView, type ActivityItem, type OperationsStatus } from "../operations/view.js";
import {
  diagnosticLogs,
  diagnosticStatus,
  type RecoveryState,
  type ServiceState,
} from "../operations/diagnostics.js";
import { managedLayout } from "./systemd.js";
import { linuxUpgradeJournalPath, readLinuxUpgradeJournal } from "./linux-installer.js";
// The readiness record is a plain runtime_meta codec with no Slack client behind it, so reporting
// it costs this read-only entry no adapter construction.
import { readSlackReadiness, type SlackReadiness } from "../slack/readiness.js";
import { pathExists, type HostOperations } from "./host.js";

/** One bounded service-manager query; a missing or slow systemctl reports "unknown", never a hang. */
export function systemdState(host: HostOperations): ServiceState {
  const result = host.run(
    "/usr/bin/systemctl",
    ["show", "--property=ActiveState", "--value", "mate.service"],
    { timeoutMs: 5000 },
  );
  const state = result.code === 0 ? result.stdout.trim() : "";
  return ["active", "inactive", "activating", "deactivating", "failed", "reloading"].includes(state)
    ? (state as ServiceState)
    : "unknown";
}
export async function readRecoveryState(
  host: HostOperations,
  data: string,
): Promise<RecoveryState> {
  const result: RecoveryState = { restore: null, invalid: false };
  try {
    result.restore = await restoreProgress(host, data);
  } catch {
    result.invalid = true;
  }
  const linux = linuxUpgradeJournalPath(data);
  if (await pathExists(host, linux))
    try {
      await readLinuxUpgradeJournal(host, linux);
      result.linuxUpgrade = { phase: "pending" };
    } catch {
      result.invalid = true;
    }
  return result;
}
/** No Daemon/Slack construction, secret environment loading, Store migration or recovery. */
export async function deploymentDiagnostics(host: HostOperations, command: "status" | "logs") {
  const recovery = await readRecoveryState(host, managedLayout.data),
    service = systemdState(host);
  let snapshot: ReturnType<typeof readOperationsSnapshot> = {
    status: null,
    items: [],
    available: false,
    more: false,
    slack: null,
  };
  try {
    const config = daemonConfigSchema.parse(JSON.parse(await host.readText(managedLayout.config)));
    if (config.runtime.dataDir === managedLayout.data)
      snapshot = readOperationsSnapshot(config, command);
  } catch {
    /* Never echo configuration parse errors. */
  }
  const { status, items, available, more } = snapshot;
  return {
    unit: "mate.service",
    ...diagnosticStatus(status, service, recovery),
    // The daemon running and Slack being ready are separate facts an operator checks separately.
    slack: snapshot.slack,
    ...(command === "logs"
      ? { logs: { available, moreAvailable: more, ...diagnosticLogs(items) } }
      : {}),
  };
}

/** Read-only snapshot shared with offline callers; errors remain opaque. */
export function readOperationsSnapshot(config: DaemonConfig, command: "status" | "logs") {
  let status: OperationsStatus | null = null,
    items: ActivityItem[] = [],
    available = false,
    more = false,
    slack: SlackReadiness | null = null;
  let db: Database.Database | undefined;
  try {
    db = new Database(join(config.runtime.dataDir, "state", "mate.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    db.pragma("query_only = ON");
    const view = new OperationsView({
        config: config.mate,
        agents: new ConfiguredAgents(config.mate.agents),
        store: { db },
      }),
      owner = config.mate.ownerUserIds[0];
    if (!owner) throw new Error("Missing owner");
    db.transaction(() => {
      status = view.status(owner);
      if (command === "logs") {
        const page = view.activity(owner, {
          sources: ["runtime", "internal_dm"],
          limit: 100,
        });
        items = page.items;
        more = page.cursor !== null;
      }
    })();
    slack = readSlackReadiness({ db });
    available = true;
  } catch {
    /* Opaque failure: exception strings can contain paths, configuration or SQL values. */
  } finally {
    db?.close();
  }
  return { status, items, available, more, slack };
}
