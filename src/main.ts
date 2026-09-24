import { LocalConsole } from "./local/console.js";
import { resolve, join, dirname } from "node:path";
import pino from "pino";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { daemonConfigSchema } from "./daemon/config.js";
import { Daemon } from "./daemon/app.js";
import { Store } from "./storage/store.js";
import { backup } from "./daemon/backup.js";
import { restoreCheckpoint } from "./daemon/restore.js";
import { requiredSlackBotScopes } from "./slack/protocol.js";
import { runDoctor } from "./deployment/doctor.js";
import { runOfflineProbe } from "./deployment/probe.js";
import { assertLinuxOperationAllowed } from "./deployment/linux-upgrade-guard.js";
import { completeManagedStartup } from "./deployment/readiness.js";
import { hostProcessManager, hostRules } from "./deployment/host-rules.js";
import {
  isEntryModule,
  nodeHostOperations,
  readOperatorText,
  type HostOperations,
} from "./deployment/host.js";

/** Maintenance commands refuse to touch a running deployment; the check goes through the host entry. */
async function assertLinuxMaintenanceStopped(
  host: HostOperations,
  config: ReturnType<typeof daemonConfigSchema.parse>,
): Promise<void> {
  if (!config.runtime.linuxUsers) return;
  if (host.euid() !== 0) throw new Error("Linux deployment maintenance requires root");
  const service = host.run(
    "/usr/bin/systemctl",
    ["show", "mate.service", "-p", "ActiveState", "--value"],
    { timeoutMs: 5000 },
  );
  if (service.code !== 0)
    throw new Error(
      `Cannot read mate.service state: ${service.stderr.trim().slice(0, 200) || "systemctl failed"}`,
    );
  if (!["inactive", "failed"].includes(service.stdout.trim()))
    throw new Error("Stop mate.service before maintenance");
  const rules = hostRules(config),
    manager = hostProcessManager(host, rules);
  for (const agent of rules.agents)
    if ((await manager.list(agent.identity.agentId)).length)
      throw new Error(`Stop ${agent.identity.agentId} background tasks before maintenance`);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command, configPath, destination] = args,
    host = nodeHostOperations();
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
    !["check", "doctor", "offline-probe", "start", "local", "backup", "restore"].includes(
      command ?? "",
    ) ||
    !configPath
  )
    throw new Error(
      "Usage: mate check|doctor|offline-probe|start|local CONFIG; mate backup CONFIG DESTINATION; mate restore CONFIG BACKUP [--replace CURRENT_CHECKPOINT]; mate models [PROVIDER]",
    );
  const config = daemonConfigSchema.parse(
    JSON.parse(await readOperatorText(host, resolve(configPath))),
  );
  if (host.platform === "linux" && !config.runtime.linuxUsers)
    throw new Error("Linux deployment requires one Linux user for every Agent");
  const releaseRoot = process.argv[1]
    ? dirname(dirname(dirname(resolve(process.argv[1]))))
    : resolve(".");
  if (command === "doctor") {
    if (destination && destination !== "--allow-missing-secrets")
      throw new Error("Unknown doctor option");
    if (args[3]) throw new Error("Unknown doctor option");
    const report = await runDoctor(host, config, {
      releaseRoot,
      requireSecrets: destination !== "--allow-missing-secrets",
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.healthy) process.exitCode = 1;
    return;
  }
  if (command === "offline-probe") {
    if (destination) throw new Error("Unknown offline-probe option");
    await assertLinuxMaintenanceStopped(host, config);
    await assertLinuxOperationAllowed(host, "offline-probe", config);
    const report = await runOfflineProbe(host, config);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
    await assertLinuxMaintenanceStopped(host, config);
    await assertLinuxOperationAllowed(host, "restore", config);
    await restoreCheckpoint(host, config, destination, {
      ...(args[4] ? { currentCheckpoint: args[4] } : {}),
    });
    process.stdout.write(
      "Checkpoint restored; start performs fenced recovery before scheduling.\n",
    );
    return;
  }
  if (command === "backup") {
    if (!destination) throw new Error("Backup destination required");
    await assertLinuxMaintenanceStopped(host, config);
    await assertLinuxOperationAllowed(host, "backup", config);
    const state = join(config.runtime.dataDir, "state"),
      release = host.lockExclusive(join(state, "daemon.lock"));
    let store: Store | undefined;
    try {
      store = new Store(join(state, "mate.sqlite"));
      store.recover();
      await backup(host, store, config.runtime.dataDir, resolve(destination), config);
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
  return isEntryModule(argument, moduleUrl);
}
if (isMainModule(process.argv[1]))
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Mate failed"}\n`);
    process.exitCode = 1;
  });
