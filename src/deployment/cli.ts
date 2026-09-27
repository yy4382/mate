import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import {
  accountServiceNames,
  accountServiceReports,
  currentAccountName,
  readServiceLog,
  serviceLogPath,
  restartAccountServices,
  startAccountServices,
  stopAccountServices,
  type AccountServiceConfig,
  type AccountServiceName,
  type AccountServiceRunResult,
} from "./account-services.js";
import {
  createMaintenanceBackup,
  reconcileDuringMaintenance,
  releaseAgentAfterReconciliation,
  restoreMaintenanceCheckpoint,
  type CoordinatedMaintenanceServices,
} from "./coordinated-maintenance.js";
import { verifyCoordinatedCheckpoint, unsettledNodeCommands } from "./coordinated-checkpoint.js";
import { reconcileCoordinatedState } from "./reconcile-coordinated-state.js";
import type { CoordinatedStatePaths } from "./coordinated-checkpoint.js";
import { isEntryModule } from "./host.js";
import { acquireLock } from "../storage/lock.js";

const agentIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const absolute = z.string().refine((value) => isAbsolute(value) && resolve(value) === value);
const origin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  });

/**
 * One ordinary account's Mate deployment. Every path is a location that account owns; nothing here
 * needs root, a Mate-created account, or a systemd unit. `publicOrigin` is what the owner types in
 * the browser; HTTPS belongs to whatever reverse proxy the host already runs.
 */
export const deploymentConfigSchema = z
  .object({
    version: z.literal(1),
    publicOrigin: origin,
    controlPlanePort: z.number().int().min(1024).max(65535),
    /** Holds the release directories and the `current` symlink. */
    releaseRoot: absolute,
    /** Holds one log and one process record per service. */
    stateDir: absolute,
    controlPlaneDataDir: absolute,
    nodeDataDir: absolute,
    agentHomeRoot: absolute,
    ownerPasswordFile: absolute,
  })
  .strict()
  .refine(
    (value) =>
      new Set([
        value.releaseRoot,
        value.stateDir,
        value.controlPlaneDataDir,
        value.nodeDataDir,
        value.agentHomeRoot,
      ]).size === 5,
    "部署路径必须互不相同",
  )
  .refine(
    (value) =>
      ![value.controlPlaneDataDir, value.nodeDataDir, value.agentHomeRoot].some(
        (path) => path === value.releaseRoot || path.startsWith(`${value.releaseRoot}${sep}`),
      ),
    "数据目录不能位于发布目录内",
  );
export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;

export interface DeploymentMaintenanceActions {
  backup(config: DeploymentConfig, destination?: string): Promise<unknown>;
  verify(config: DeploymentConfig, checkpoint: string): unknown;
  restore(config: DeploymentConfig, checkpoint: string): Promise<unknown>;
  reconcile(config: DeploymentConfig): unknown;
  releaseAgent(config: DeploymentConfig, agentId: string): unknown;
}

export interface DeploymentCliDependencies {
  readConfig?: (path: string) => DeploymentConfig;
  services?: (config: DeploymentConfig) => DeploymentServices;
  installRelease?: (config: DeploymentConfig, release: string) => string;
  maintenance?: DeploymentMaintenanceActions;
  write?: (text: string) => void;
}

/** The process operations the CLI needs; substituted only to unit-test command routing. */
export interface DeploymentServices {
  start(
    names?: readonly AccountServiceName[],
    options?: { onAlreadyRunning?: "throw" | "skip" },
  ): Promise<AccountServiceRunResult>;
  stop(
    names?: readonly AccountServiceName[],
    options?: { stopTimeoutMs?: number },
  ): Promise<AccountServiceRunResult>;
  restart(
    names?: readonly AccountServiceName[],
    options?: { stopTimeoutMs?: number },
  ): Promise<AccountServiceRunResult>;
  reports(): Record<string, unknown>;
}

export function readDeploymentConfig(path: string): DeploymentConfig {
  const canonical = resolve(path);
  if (canonical !== path) throw new Error("Config path must be absolute and lexical-canonical");
  return deploymentConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * The only supported first-release installer: it prepares a release directory and starts the
 * control plane as an ordinary process of the account running it. The node starts with `start`,
 * because a new node needs the one-time pairing token the owner creates in the web page. Nothing
 * here creates an account, switches UID or GID, or installs, enables or reloads a systemd unit.
 */
export async function deploymentMain(
  args = process.argv.slice(2),
  dependencies: DeploymentCliDependencies = {},
): Promise<void> {
  const [action, configPath, value] = args;
  const readConfig = dependencies.readConfig ?? readDeploymentConfig;
  const write = dependencies.write ?? ((text) => process.stdout.write(text));
  const forConfig = (config: DeploymentConfig) =>
    dependencies.services?.(config) ?? accountDeploymentServices(config);
  const maintenance = () => dependencies.maintenance ?? defaultMaintenance(forConfig);
  if (action === "install" && args.length === 3 && configPath && value) {
    const config = readConfig(configPath);
    writeJson(
      write,
      await withMaintenanceLock(config, async () => {
        const release = (dependencies.installRelease ?? installRelease)(config, value);
        const services = forConfig(config);
        // A node without a saved identity needs the one-time pairing token the owner creates in the
        // web page, so installation starts only the control plane and reports what to do next.
        const controlPlane = await services.start(["control-plane"], { onAlreadyRunning: "skip" });
        return {
          release,
          services: { ...services.reports(), ...controlPlane.reports },
          next: nodeCanPair(config)
            ? "运行 `start` 启动节点。"
            : "在网页生成一次性配对令牌，用 MATE_NODE_PAIRING_TOKEN 环境变量运行 `start` 启动节点。",
        };
      }),
    );
    return;
  }
  if (action === "upgrade" && args.length === 3 && configPath && value) {
    const config = readConfig(configPath);
    writeJson(
      write,
      await withMaintenanceLock(config, () =>
        upgradeDeployment(config, value, forConfig(config), dependencies.installRelease),
      ),
    );
    return;
  }
  if (action === "status" && args.length === 2 && configPath) {
    const config = readConfig(configPath);
    writeJson(write, await accountStatus(config, forConfig(config)));
    return;
  }
  if (action === "start" && (args.length === 2 || args.length === 3) && configPath) {
    // `start` is the request to bring services up, so an already-running one is reported, not
    // refused: this is the documented step after `install`, which starts only the control plane
    // because a new node needs the owner's one-time pairing token.
    const config = readConfig(configPath),
      names = serviceSelection(value, action, accountServiceNames),
      services = forConfig(config);
    writeJson(
      write,
      await withMaintenanceLock(config, async () => {
        const started = await services.start(names, { onAlreadyRunning: "skip" });
        return { services: { ...services.reports(), ...started.reports } };
      }),
    );
    return;
  }
  if (
    (action === "stop" || action === "restart") &&
    (args.length === 2 || args.length === 3) &&
    configPath
  ) {
    const config = readConfig(configPath),
      names = serviceSelection(value, action, accountServiceNames),
      services = forConfig(config);
    writeJson(
      write,
      await withMaintenanceLock(config, async () => {
        const result =
          action === "stop" ? await services.stop(names) : await services.restart(names);
        return { services: { ...services.reports(), ...result.reports } };
      }),
    );
    return;
  }
  if (action === "logs" && args.length === 2 && configPath) {
    const config = readConfig(configPath);
    const services = accountServiceConfig(config);
    for (const name of accountServiceNames)
      write(`== ${name} ==\n${readServiceLog(name, services)}\n`);
    return;
  }
  if (action === "doctor" && args.length === 2 && configPath) {
    const config = readConfig(configPath);
    writeJson(write, await accountDoctor(config, forConfig(config)));
    return;
  }
  if (
    configPath &&
    action &&
    ["backup", "verify", "restore", "reconcile", "release-agent"].includes(action)
  ) {
    const config = readConfig(configPath);
    const actions = maintenance();
    // Every maintenance action that stops services, copies state or moves it takes the one
    // deployment lock, so nothing else on this host can write into what it is holding still.
    // `verify` reads a checkpoint and takes nothing.
    if (action === "backup" && (args.length === 2 || args.length === 3)) {
      writeJson(write, await withMaintenanceLock(config, () => actions.backup(config, value)));
      return;
    }
    if (action === "verify" && args.length === 3 && value) {
      writeJson(write, actions.verify(config, value));
      return;
    }
    if (action === "restore" && args.length === 3 && value) {
      writeJson(write, await withMaintenanceLock(config, () => actions.restore(config, value)));
      return;
    }
    if (action === "reconcile" && args.length === 2) {
      writeJson(write, await withMaintenanceLock(config, async () => actions.reconcile(config)));
      return;
    }
    if (action === "release-agent" && args.length === 3 && value && agentIdPattern.test(value)) {
      writeJson(
        write,
        await withMaintenanceLock(config, async () => actions.releaseAgent(config, value)),
      );
      return;
    }
  }
  throw new Error(
    "Usage: mate-deploy install CONFIG RELEASE; upgrade CONFIG RELEASE; start|stop|restart CONFIG [control-plane|node]; status|logs|doctor CONFIG; backup CONFIG [CHECKPOINT]; verify CONFIG CHECKPOINT; restore CONFIG CHECKPOINT; reconcile CONFIG; release-agent CONFIG AGENT_ID",
  );
}

/** The release layout the owner runs both services from. */
export const releaseLayout = (config: DeploymentConfig) => ({
  releases: join(config.releaseRoot, "releases"),
  current: join(config.releaseRoot, "current"),
  releaseEntry: join(config.releaseRoot, "current", "dist", "src"),
});

export function accountServiceConfig(config: DeploymentConfig): AccountServiceConfig {
  const layout = releaseLayout(config);
  return {
    stateDir: config.stateDir,
    entries: {
      "control-plane": join(layout.releaseEntry, "control-plane", "main.js"),
      node: join(layout.releaseEntry, "node", "main.js"),
    },
    environment: {
      "control-plane": {
        MATE_CONTROL_PLANE_PORT: String(config.controlPlanePort),
        MATE_CONTROL_PLANE_DATA_DIR: config.controlPlaneDataDir,
        MATE_PUBLIC_ORIGIN: config.publicOrigin,
        MATE_OWNER_PASSWORD_FILE: config.ownerPasswordFile,
      },
      node: {
        MATE_CONTROL_PLANE_URL: `http://127.0.0.1:${config.controlPlanePort}`,
        MATE_NODE_DATA_DIR: config.nodeDataDir,
        MATE_NODE_AGENT_WORKSPACE_ROOT: config.agentHomeRoot,
      },
    },
    // The control plane's own status endpoint is the only local endpoint that answers.
    probeUrls: { "control-plane": `http://127.0.0.1:${config.controlPlanePort}/api/status` },
  };
}

/**
 * The services whose stop is not accounted for, with what was left unconfirmed. A service that
 * could not be confirmed stopped is still there; a service that stopped but said a command it had
 * started may still be running leaves work that can still write to the state a checkpoint copies.
 * Either way the answer is the same: do not copy it and do not call the stop clean.
 */
function unaccountedStops(result: AccountServiceRunResult): string[] {
  const found: string[] = [];
  for (const [name, report] of Object.entries(result.reports)) {
    if (!report) continue;
    if (report.state === "unconfirmed")
      found.push(`${name} 未能确认停止（进程 ${report.remaining ?? report.pid ?? "未知"}）`);
    else if (report.state === "stopped" && report.unconfirmedCommands !== undefined)
      found.push(
        `${name} 未能确认结束它启动的命令（${
          report.unconfirmedCommands === "unknown" ? "数量未知" : `${report.unconfirmedCommands} 个`
        }）`,
      );
  }
  return found;
}

/**
 * The one reason a checkpoint may not be taken, beyond what the service stop reported: commands the
 * node recorded as started and never settled. Those are commands whose process groups outlive the
 * node, so neither the node's own shutdown report nor the service's stop can speak for them; the
 * durable receipts can, and a checkpoint taken over them would copy state that is still changing.
 */
function unsettledCommandsReason(config: DeploymentConfig): string | undefined {
  const unsettled = unsettledNodeCommands(config.nodeDataDir);
  return unsettled > 0
    ? `节点操作收据里还有 ${unsettled} 个已开始但未结束的命令；不在可能有命令仍在写入时创建检查点。`
    : undefined;
}

/**
 * Everything a maintenance step does — stop, copy, restore — assumes nothing else is doing the
 * same. Two of them interleaved would have the second copy state the first had already resumed the
 * services on, and certify it; one kernel lock per deployment state directory makes the second one
 * fail instead. The lock is released when the process exits, so a killed maintenance does not leave
 * it held.
 */
function withMaintenanceLock<T>(config: DeploymentConfig, work: () => Promise<T>): Promise<T> {
  ensureStateDirectory(config);
  const release = acquireLock(join(config.stateDir, "maintenance.lock"));
  return Promise.resolve().then(work).finally(release);
}

/** The deployment's own state directory, private to the running account, as Mate always keeps it. */
function ensureStateDirectory(config: DeploymentConfig): string {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(config.stateDir, 0o700);
  return config.stateDir;
}

/**
 * Start the control plane first, so a node that reconnects finds it listening.
 */
export function accountDeploymentServices(config: DeploymentConfig): DeploymentServices {
  const services = accountServiceConfig(config);
  return {
    start: (names, options) => startAccountServices(services, names, options),
    stop: (names, options) => stopAccountServices(services, names, options),
    restart: (names, options) => restartAccountServices(services, names, options),
    reports: () => accountServiceReports(services),
  };
}

/**
 * One service name, or both in start order, or both in stop order. The owner names a service to
 * operate on one at a time — restarting only the node while the control plane keeps serving, or
 * stopping only the node to check the page reports it offline — and gets a usage error otherwise
 * rather than a silently different operation.
 */
function serviceSelection(
  value: string | undefined,
  action: string,
  order: readonly AccountServiceName[],
): readonly AccountServiceName[] {
  if (value === undefined) return order;
  if ((accountServiceNames as readonly string[]).includes(value))
    return [value as AccountServiceName];
  throw new Error(`Usage: mate-deploy ${action} CONFIG [${accountServiceNames.join("|")}]`);
}

/**
 * Whether this node can authenticate without a fresh pairing token: it either already saved an
 * identity, or the owner supplied the one-time token the web page generated.
 */
export function nodeCanPair(
  config: DeploymentConfig,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (existsSync(join(config.nodeDataDir, "node-identity.json"))) return true;
  const token = environment.MATE_NODE_PAIRING_TOKEN;
  return typeof token === "string" && token.length >= 32 && token.length <= 256;
}

/**
 * What the owner can see from this host without credentials: whether each process is there, and
 * whether the control plane answers its own status endpoint. "The node is really connected" is a
 * control-plane fact and belongs to the web page, which the ticket requires; this reports the
 * process facts and points at the log instead of guessing.
 */
export async function accountStatus(
  config: DeploymentConfig,
  services: DeploymentServices,
): Promise<Record<string, unknown>> {
  const layout = releaseLayout(config);
  return {
    account: currentAccountName(),
    release: existsSync(layout.current) ? readlinkSync(layout.current) : null,
    publicOrigin: config.publicOrigin,
    controlPlaneUrl: `http://127.0.0.1:${config.controlPlanePort}`,
    services: services.reports(),
  };
}

export async function accountDoctor(
  config: DeploymentConfig,
  services: DeploymentServices,
): Promise<Record<string, unknown>> {
  const status = await accountStatus(config, services);
  let controlPlaneHttp = "unavailable";
  try {
    const response = await fetch(`http://127.0.0.1:${config.controlPlanePort}/api/status`, {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok && ((await response.json()) as { status?: string }).status === "running")
      controlPlaneHttp = "running";
  } catch {
    /* The control plane may be down, still starting, or bound elsewhere; the report says so. */
  }
  return { ...status, controlPlaneHttp, logs: serviceLogPaths(config) };
}

function serviceLogPaths(config: DeploymentConfig): Record<string, string> {
  const services = accountServiceConfig(config);
  return Object.fromEntries(
    accountServiceNames.map((name) => [name, serviceLogPath(name, services)]),
  );
}

/** Stage a built release under the release root and point `current` at it. */
export function installRelease(config: DeploymentConfig, source: string): string {
  const path = resolve(source);
  if (path !== source || !isDirectory(path))
    throw new Error("Release source must be an absolute directory");
  for (const file of [
    "dist/src/control-plane/main.js",
    "dist/src/node/main.js",
    "dist/web/index.html",
    "package.json",
    "node_modules",
  ])
    if (!existsSync(join(path, file))) throw new Error(`Release is missing ${file}`);
  const layout = releaseLayout(config),
    digest = releaseDigest(path),
    release = join(layout.releases, digest);
  if (existsSync(release)) {
    if (!isDirectory(release) || releaseDigest(release) !== digest)
      throw new Error("Release identity collision");
  } else {
    mkdirSync(layout.releases, { recursive: true, mode: 0o755 });
    const stage = join(layout.releases, `.stage-${process.pid}`);
    if (existsSync(stage)) throw new Error("Release staging path already exists");
    mkdirSync(stage, { mode: 0o755 });
    try {
      for (const file of ["dist", "node_modules", "package.json", "pnpm-lock.yaml"])
        copyTree(join(path, file), join(stage, file));
      if (releaseDigest(stage) !== digest)
        throw new Error("Release changed while it was being copied");
      renameSync(stage, release);
    } catch (error) {
      rmSync(stage, { recursive: true, force: true });
      throw error;
    }
  }
  if (existsSync(layout.current) && !lstatSync(layout.current).isSymbolicLink())
    throw new Error("Current release path is not a symlink");
  const next = `${layout.current}.next-${process.pid}`;
  rmSync(next, { force: true });
  symlinkSync(release, next);
  renameSync(next, layout.current);
  return release;
}

/**
 * Switch versions without losing the evidence needed to go back: stop both services, checkpoint the
 * databases, node identity and Agent workspaces, then publish the new release and start it again.
 */
async function upgradeDeployment(
  config: DeploymentConfig,
  source: string,
  services: DeploymentServices,
  install: DeploymentCliDependencies["installRelease"],
): Promise<Record<string, unknown>> {
  const stoppingNames = accountServiceNames.filter(
    (name) => (services.reports()[name] as { state?: string } | undefined)?.state === "running",
  );
  const stopped = await services.stop(stoppingNames);
  // An upgrade takes a recovery point from this state before it switches versions, so it carries the
  // same "nothing unsettled may be copied" rule a backup does.
  const unsettled = unsettledCommandsReason(config);
  const unaccounted = [...unaccountedStops(stopped), ...(unsettled ? [unsettled] : [])];
  if (unaccounted.length > 0) {
    // The services this upgrade stopped are put back before the refusal: an upgrade that cannot
    // take its recovery point has changed nothing yet, so the deployment it found keeps running.
    await services.start(stoppingNames, { onAlreadyRunning: "skip" }).catch(() => undefined);
    throw new Error(`${unaccounted.join("、")}；不在工作可能仍在写入时切换发布版本。`);
  }
  const checkpoint = ownCheckpointDestination(config);
  // The services are already stopped and confirmed above, so the checkpoint's own quiesce step has
  // nothing left to do. The callbacks are real no-ops rather than a claim that stopping happened
  // twice; `services.start(previouslyRunning)` below is what brings the services back.
  const manifest = await createMaintenanceBackup(statePaths(config), checkpoint, {
    stop: () => undefined,
    resume: () => undefined,
  });
  try {
    const release = (install ?? installRelease)(config, source);
    // Only the services this upgrade actually stopped come back, so a host that runs without a
    // paired node is not asked to start one — that would fail after `current` had already moved.
    return {
      release,
      checkpoint: manifest.id,
      checkpointPath: checkpoint,
      services: (await services.start(stoppingNames, { onAlreadyRunning: "skip" })).reports,
    };
  } catch (error) {
    // The new release could not be started. `current` already points at it, so the previous release
    // has to be published again before the old services can run; that is a separate, explicit
    // install, and the error names it together with the checkpoint that makes it safe. Only the
    // services that were stopped here are asked to come back, so a control-plane-only host is not
    // handed a node it never ran.
    const previouslyRunning = stoppingNames;
    await services.start(previouslyRunning, { onAlreadyRunning: "skip" }).catch(() => undefined);
    throw new Error(
      `${error instanceof Error ? error.message : "升级失败"}；` +
        `发布版本已切到 ${releaseLayout(config).current}，旧版本不再在 current 上。` +
        `用检查点 ${checkpoint} 恢复数据，再在旧发布目录里运行 install 重新指向它。`,
    );
  }
}

export function defaultMaintenance(
  servicesFor: (config: DeploymentConfig) => DeploymentServices,
): DeploymentMaintenanceActions {
  const maintenanceServices = (
    config: DeploymentConfig,
    /** A step that copies this state needs more than a stop; a repair pass only rechecks it. */
    copiesState = false,
    /** The one service instance this step acts on and reports on; a caller may already own it. */
    services = servicesFor(config),
  ): CoordinatedMaintenanceServices => {
    // Which services were up before maintenance is what gets resumed: a host that runs only the
    // control plane must not be given a node (and a tokenless node start would fail anyway).
    let previouslyRunning: readonly AccountServiceName[] | undefined;
    const runningNames = (): readonly AccountServiceName[] =>
      accountServiceNames.filter(
        (name) => (services.reports()[name] as { state?: string } | undefined)?.state === "running",
      );
    return {
      async stop() {
        previouslyRunning ??= runningNames();
        const stopped = await services.stop(previouslyRunning);
        const unaccounted = unaccountedStops(stopped);
        // The contract this callback carries is "both services and their Agent processes are not
        // running". A service that could not be confirmed stopped, or one that reported commands it
        // could not confirm ended, leaves operations live, so the checkpoint must not be taken;
        // `coordinated-maintenance` recovers the service state.
        if (unaccounted.length > 0)
          throw new Error(`${unaccounted.join("、")}；不在工作可能仍在写入时创建检查点。`);
        // Only a step that copies this state needs the durable receipts to be settled too. A repair
        // pass — `reconcile`, `release-agent`, a restore — exists precisely to deal with results
        // nobody could confirm, so gating it here would leave the owner no way to repair them.
        const unsettled = copiesState ? unsettledCommandsReason(config) : undefined;
        if (unsettled) throw new Error(unsettled);
        return stopped;
      },
      resume() {
        if (!previouslyRunning || previouslyRunning.length === 0) return undefined;
        return services.start(previouslyRunning, { onAlreadyRunning: "skip" });
      },
    };
  };
  return {
    async backup(config, destination) {
      const checkpoint = destination ?? ownCheckpointDestination(config);
      const manifest = await createMaintenanceBackup(
        statePaths(config),
        checkpoint,
        maintenanceServices(config, true),
      );
      return { checkpoint, id: manifest.id, entries: manifest.entries.length };
    },
    verify(config, checkpoint) {
      void config;
      return verifyCoordinatedCheckpoint(checkpoint);
    },
    async restore(config, checkpoint) {
      const paths = statePaths(config),
        // One instance stops and resumes the services and the same one reports their state, so the
        // report cannot come from a second view of the deployment that did none of the work.
        services = servicesFor(config);
      // The owner's report names the checkpoint that was applied, the state it replaced (which is
      // kept on disk under the names it gives), what the reconciliation proved, and whether the
      // services came back — the four facts that separate a restore from a refusal.
      const restored = await restoreMaintenanceCheckpoint(
        checkpoint,
        paths,
        maintenanceServices(config, false, services),
        () => reconcileCoordinatedState(paths),
      );
      return {
        checkpoint: resolve(checkpoint),
        id: restored.manifest.id,
        previous: restored.previous,
        ...restored.reconciliation,
        services: services.reports(),
      };
    },
    reconcile(config) {
      const paths = statePaths(config);
      return reconcileDuringMaintenance(maintenanceServices(config), () =>
        reconcileCoordinatedState(paths),
      );
    },
    releaseAgent(config, agentId) {
      const paths = statePaths(config);
      return releaseAgentAfterReconciliation(agentId, () =>
        reconcileDuringMaintenance(maintenanceServices(config), () =>
          reconcileCoordinatedState(paths),
        ),
      );
    },
  };
}

function statePaths(config: DeploymentConfig) {
  return {
    controlPlaneDataDir: config.controlPlaneDataDir,
    nodeDataDir: config.nodeDataDir,
    agentHomeRoot: config.agentHomeRoot,
  };
}

function newCheckpointName(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Where Mate keeps its own checkpoints: one private directory under the state the running account
 * already owns. Mate makes this place, because it is Mate's own state directory and the documented
 * `backup CONFIG` form has nowhere else to write. An owner-supplied destination is left alone: a
 * mistyped path fails loudly instead of having a directory tree appear where nobody asked for one.
 */
function ownCheckpointDestination(config: DeploymentConfig): string {
  const directory = join(ensureStateDirectory(config), "checkpoints");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return join(directory, newCheckpointName());
}

/** A content digest of one release, so two builds of the same tree share one directory. */
export function releaseDigest(root: string): string {
  const digest = createHash("sha256");
  for (const file of ["package.json", "pnpm-lock.yaml"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    digest.update(file);
    digest.update(readFileSync(path));
  }
  const walk = (folder: string): void => {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const name = join(folder, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) digest.update(name).update(readFileSync(join(root, name)));
      else if (entry.isSymbolicLink()) {
        digest.update(name).update(releaseLinkTarget(root, name));
      } else throw new Error(`Release contains a non-regular entry: ${name}`);
    }
  };
  walk("dist");
  walk("node_modules");
  return digest.digest("hex").slice(0, 24);
}

/**
 * Where one release symlink points, resolved the way the kernel will resolve it. A packaged
 * dependency tree legitimately links between its own directories, so a relative link that stays
 * inside the release is fine; an absolute link, or one that leaves the release, makes the package
 * non-portable and is refused.
 */
function releaseLinkTarget(root: string, name: string): string {
  const target = readlinkSync(join(root, name)),
    resolved = target.startsWith("/") ? resolve(target) : resolve(root, dirname(name), target);
  if (target.startsWith("/") || (resolved !== root && !resolved.startsWith(`${root}${sep}`)))
    throw new Error(`Release contains a symlink outside its root: ${name}`);
  return target;
}

/** Copy a release tree without following a symlink out of it. */
function copyTree(from: string, to: string): void {
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(from);
    if (target.startsWith("/")) throw new Error(`Release symlink is absolute: ${from}`);
    symlinkSync(target, to);
    return;
  }
  if (stat.isDirectory()) {
    mkdirSync(to, { mode: stat.mode & 0o777 });
    for (const entry of readdirSync(from, { withFileTypes: true }))
      copyTree(join(from, entry.name), join(to, entry.name));
    return;
  }
  writeFileSync(to, readFileSync(from), { mode: stat.mode & 0o777 });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function writeJson(write: (text: string) => void, value: unknown): void {
  write(`${JSON.stringify(value, null, 2)}\n`);
}

export function isDeploymentMainModule(
  argument: string | undefined,
  moduleUrl = import.meta.url,
): boolean {
  return isEntryModule(argument, moduleUrl);
}

if (isDeploymentMainModule(process.argv[1]))
  deploymentMain().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Mate deployment failed"}\n`);
    process.exitCode = 1;
  });
