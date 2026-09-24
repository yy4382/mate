import { LocalConsole } from "./local/console.js";
import { spawnSync } from "node:child_process";
import { migrateConfiguration } from "./daemon/migrate.js";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { daemonConfigSchema } from "./daemon/config.js";
import { Daemon } from "./daemon/app.js";
import { acquireLock } from "./daemon/lock.js";
import { Store, hash } from "./storage/store.js";
import { backup } from "./daemon/backup.js";
import { restoreCheckpoint } from "./daemon/restore.js";
import { requiredSlackBotScopes } from "./slack/protocol.js";
import { runDoctor } from "./deployment/doctor.js";
import { runOfflineProbe } from "./deployment/probe.js";
import { assertLinuxOperationAllowed } from "./deployment/linux-upgrade-guard.js";
import { completeManagedStartup } from "./deployment/readiness.js";
import { LinuxProcessManager } from "./execution/linux-processes.js";

function assertLinuxMaintenanceStopped(config: ReturnType<typeof daemonConfigSchema.parse>): void {
  if (!config.runtime.linuxUsers) return;
  if (process.getuid?.() !== 0) throw new Error("Linux deployment maintenance requires root");
  const service = spawnSync(
    "/usr/bin/systemctl",
    ["show", "mate.service", "-p", "ActiveState", "--value"],
    { encoding: "utf8", timeout: 5000 },
  );
  if (service.error) throw service.error;
  if (service.status !== 0 || !["inactive", "failed"].includes(service.stdout.trim()))
    throw new Error("Stop mate.service before maintenance");
  const manager = new LinuxProcessManager(
    Object.fromEntries(
      Object.entries(config.runtime.linuxUsers).map(([id, user]) => [id, user.uid]),
    ),
  );
  for (const agentId of Object.keys(config.runtime.linuxUsers))
    if (manager.list(agentId).length)
      throw new Error(`Stop ${agentId} background tasks before maintenance`);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, configPath, destination] = args;
  if (command === "models") {
    process.stdout.write(
      JSON.stringify(
        builtinModels()
          .getModels(configPath)
          .map((m) => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow })),
        null,
        2,
      ) + "\n",
    );
    return;
  }
  if (
    ![
      "check",
      "doctor",
      "offline-probe",
      "start",
      "local",
      "backup",
      "restore",
      "migrate",
    ].includes(command ?? "") ||
    !configPath
  )
    throw new Error(
      "Usage: mate check|doctor|offline-probe|start|local CONFIG; mate backup CONFIG DESTINATION; mate restore CONFIG BACKUP [--replace CURRENT_CHECKPOINT]; mate models [PROVIDER]",
    );
  const rawConfig = JSON.parse(readFileSync(resolve(configPath), "utf8"));
  const legacyQuotaConfig = Boolean(rawConfig?.mate?.budgets);
  const config = daemonConfigSchema.parse(rawConfig);
  if (command === "start" && legacyQuotaConfig)
    process.stderr.write(
      "Mate: legacy mate.budgets quotas are ignored; only runTimeoutMs is used.\n",
    );
  if (process.platform === "linux" && !config.runtime.linuxUsers)
    throw new Error("Linux deployment requires one Linux user for every Agent");
  const releaseRoot = process.argv[1]
    ? dirname(dirname(dirname(resolve(process.argv[1]))))
    : resolve(".");
  if (command === "doctor") {
    if (destination && destination !== "--allow-missing-secrets")
      throw new Error("Unknown doctor option");
    if (args[3]) throw new Error("Unknown doctor option");
    const report = await runDoctor(config, undefined, {
      releaseRoot,
      requireSecrets: destination !== "--allow-missing-secrets",
      legacyQuotaConfig,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.healthy) process.exitCode = 1;
    return;
  }
  if (command === "offline-probe") {
    if (destination) throw new Error("Unknown offline-probe option");
    assertLinuxMaintenanceStopped(config);
    assertLinuxOperationAllowed("offline-probe", config);
    const report = await runOfflineProbe(config);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (command === "migrate") {
    if (!destination || !args[3])
      throw new Error("Usage: mate migrate OLD_CONFIG NEW_CONFIG BACKUP");
    if (args[4]) throw new Error("Unknown migration option");
    assertLinuxMaintenanceStopped(config);
    assertLinuxOperationAllowed("migrate", config);
    const next = daemonConfigSchema.parse(JSON.parse(readFileSync(resolve(destination), "utf8")));
    process.stdout.write(
      JSON.stringify(await migrateConfiguration(config, next, args[3]), null, 2) + "\n",
    );
    return;
  }
  if (command === "check") {
    const models = builtinModels();
    const report = config.mate.agents.map((a) => ({
      agent: a.id,
      modelKnown: !!models.getModel(a.model.provider, a.model.id),
      missingEnv: [
        a.model.apiKeyEnv,
        ...(config.adapters.slack?.bindings
          .filter((b) => b.agentId === a.id)
          .flatMap((b) => [b.botTokenEnv, b.appTokenEnv]) ?? []),
      ].filter((ref) => !process.env[ref]),
    }));
    process.stdout.write(
      JSON.stringify(
        {
          checkScope: "configuration_model_and_secret_references",
          externalConnectivityChecked: false,
          adapters: {
            slackConfigured: !!config.adapters.slack,
            localConfigured: !!config.adapters.local,
          },
          requiredSlackBotScopes: config.adapters.slack ? [...requiredSlackBotScopes] : [],
          agents: report,
          isolation: config.runtime.linuxUsers
            ? {
                mode: "linux-users",
                identities: Object.fromEntries(
                  Object.entries(config.runtime.linuxUsers).map(([id, user]) => [
                    id,
                    { uid: user.uid, gid: user.gid, home: user.home },
                  ]),
                ),
                sharedRoot: config.runtime.sharedRoot,
              }
            : { mode: "local-development" },
          runtimeLimits: config.runtime.limits,
        },
        null,
        2,
      ) + "\n",
    );
    if (report.some((r) => !r.modelKnown || r.missingEnv.length)) process.exitCode = 1;
    return;
  }
  if (command === "restore") {
    if (!destination) throw new Error("Backup directory required");
    if (args[3] && args[3] !== "--replace") throw new Error("Unknown restore option");
    if (args[3] === "--replace" && !args[4])
      throw new Error("Current checkpoint required after --replace");
    if (args[5]) throw new Error("Unknown restore option");
    assertLinuxMaintenanceStopped(config);
    assertLinuxOperationAllowed("restore", config);
    await restoreCheckpoint(config, destination, {
      ...(args[4] ? { currentCheckpoint: args[4] } : {}),
    });
    process.stdout.write(
      "Checkpoint restored; start performs fenced recovery before scheduling.\n",
    );
    return;
  }
  if (command === "backup") {
    if (!destination) throw new Error("Backup destination required");
    assertLinuxMaintenanceStopped(config);
    assertLinuxOperationAllowed("backup", config);
    const state = join(config.runtime.dataDir, "state"),
      release = acquireLock(join(state, "daemon.lock"));
    let store: Store | undefined;
    try {
      store = new Store(join(state, "mate.sqlite"));
      store.recover();
      await backup(store, config.runtime.dataDir, resolve(destination), config);
    } finally {
      store?.close();
      release();
    }
    process.stdout.write("Consistent database and memory checkpoint created.\n");
    return;
  }
  const log = pino(
    {
      level: "info",
      redact: ["token", "apiKey", "authorization", "*.token", "*.apiKey", "*.authorization"],
    },
    pino.destination(2),
  );
  const daemon = await Daemon.create(config, log);
  const consoleAbort = new AbortController();
  let closing: Promise<void> | undefined;
  const close = () => {
    consoleAbort.abort();
    closing ??= daemon.close();
    return closing;
  };
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  try {
    if (command === "local" && !daemon.local)
      throw new Error("Configure adapters.local before using the local console");
    if (command === "start") await completeManagedStartup((progress) => daemon.start(progress));
    else await daemon.start();
    if (command === "local") {
      await new LocalConsole(daemon.local!, daemon.controls).serve(
        process.stdin,
        process.stdout,
        consoleAbort.signal,
      );
      await close();
    }
  } catch {
    await close();
    throw new Error("Daemon startup failed; check installation identities and credentials");
  }
}
export function isMainModule(argument: string | undefined, moduleUrl = import.meta.url): boolean {
  return !!argument && moduleUrl === pathToFileURL(realpathSync(resolve(argument))).href;
}
if (isMainModule(process.argv[1]))
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Mate failed"}\n`);
    process.exitCode = 1;
  });
