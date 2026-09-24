import { join } from "node:path";
import Database from "better-sqlite3";
import { daemonConfigSchema, type DaemonConfig } from "../daemon/config.js";
import { restoreProgress } from "../daemon/restore.js";
import { ConfiguredAgents } from "../agents/directory.js";
import { OperationsView, type ActivityItem, type OperationsStatus } from "../operations/view.js";
import {
  collectDiagnosis,
  type DiagnosisReport,
  type ServiceState,
} from "../operations/diagnosis.js";
import { diagnosticLogs, diagnosticStatus, type RecoveryState } from "../operations/diagnostics.js";
import { managedLayout } from "./systemd.js";
import { linuxUpgradeJournalPath, readLinuxUpgradeJournal } from "./linux-installer.js";
// The readiness record is a plain runtime_meta codec with no Slack client behind it, so reporting
// it costs this read-only entry no adapter construction.
import { readSlackReadinessRecord, type SlackReadiness } from "../slack/readiness.js";
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
    // One bounded service-manager query; its own source, so a slow or missing systemctl reports
    // "unknown" without touching the facts read below.
    service = systemdState(host);
  let snapshot: OperationsSnapshot = emptySnapshot(service);
  let configured: DaemonConfig | null = null;
  try {
    configured = daemonConfigSchema.parse(JSON.parse(await host.readText(managedLayout.config)));
  } catch {
    /* Never echo configuration parse errors. */
  }
  if (configured && configured.runtime.dataDir === managedLayout.data)
    snapshot = readOperationsSnapshot(configured, command, service);
  const { status, items, available, more } = snapshot;
  return {
    unit: "mate.service",
    ...diagnosticStatus(status, service, recovery),
    // The daemon running and Slack being ready are separate facts an operator checks separately.
    slack: snapshot.slack,
    // Every source above is reported with whether it answered, and a failed source never erases
    // another's result.
    diagnosis: snapshot.diagnosis,
    ...(command === "logs"
      ? { logs: { available, moreAvailable: more, ...diagnosticLogs(items) } }
      : {}),
  };
}

/** What one read-only pass over the deployment's durable records reports. */
export interface OperationsSnapshot {
  status: OperationsStatus | null;
  items: ActivityItem[];
  /** Whether the database answered the read this command needs: the owner status, or the log page. */
  available: boolean;
  more: boolean;
  slack: SlackReadiness | null;
  diagnosis: DiagnosisReport;
}

/** The report of a deployment whose configuration or database could not be read at all. */
function emptySnapshot(service: ServiceState | null): OperationsSnapshot {
  return {
    status: null,
    items: [],
    available: false,
    more: false,
    slack: null,
    diagnosis: collectDiagnosis({
      daemon: () => service,
      slack: () => null,
      agents: () => [],
      execution: () => [],
    }),
  };
}

/** Read-only snapshot shared with offline callers; errors remain opaque. */
export function readOperationsSnapshot(
  config: DaemonConfig,
  command: "status" | "logs",
  service: ServiceState | null = null,
): OperationsSnapshot {
  let db: Database.Database | undefined;
  try {
    db = new Database(join(config.runtime.dataDir, "state", "mate.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    db.pragma("query_only = ON");
    const opened = db,
      view = new OperationsView({
        config: config.mate,
        agents: new ConfiguredAgents(config.mate.agents),
        store: { db },
        // A missing service-manager answer is stated as the view's own default, not as a fact.
        ...(service ? { service: () => service } : {}),
      }),
      owner = config.mate.ownerUserIds[0];
    if (!owner) throw new Error("Missing owner");
    // Each diagnostic source is read in its own attempt. A read this database cannot answer leaves
    // that source unavailable and every other source's result exactly as it is.
    const read = <T>(source: () => T, fallback: T): T => {
      try {
        return source();
      } catch {
        /* Opaque failure: exception strings can contain paths, configuration or SQL values. */
        return fallback;
      }
    };
    const status = read(() => opened.transaction(() => view.status(owner))(), null),
      page =
        command === "logs"
          ? read(
              () =>
                opened.transaction(() =>
                  view.activity(owner, { sources: ["runtime", "internal_dm"], limit: 100 }),
                )(),
              null,
            )
          : null,
      slack = read(() => readSlackReadinessRecord({ db: opened }), null);
    // The deployment's own sources are composed here. The service manager's answer and the Slack
    // record are read independently of the owner status, so a status read that failed leaves both
    // of them intact.
    const fromStatus = (source: "agents" | "execution") => () => {
      if (!status) throw new Error("Owner operations status unavailable");
      return status.diagnosis.conditions.filter((condition) => condition.source === source);
    };
    return {
      status,
      items: page?.items ?? [],
      available: (command === "logs" ? page : status) !== null,
      more: page?.cursor !== null && page?.cursor !== undefined,
      slack: slack?.state === "read" ? slack.readiness : null,
      diagnosis: collectDiagnosis({
        daemon: () => service,
        slack: () => {
          // A record that was never published is not a failure; one that cannot be read is.
          if (!slack || slack.state === "unreadable")
            throw new Error("Slack readiness unavailable");
          return slack.state === "read" ? slack.readiness : null;
        },
        agents: fromStatus("agents"),
        execution: fromStatus("execution"),
      }),
    };
  } catch {
    /* Opaque failure: exception strings can contain paths, configuration or SQL values. */
    return emptySnapshot(service);
  } finally {
    db?.close();
  }
}
