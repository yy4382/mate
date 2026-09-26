import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { dualServiceDoctor, installDualService, readDualServiceConfig } from "./dual-installer.js";
import {
  createMaintenanceBackup,
  reconcileDuringMaintenance,
  releaseAgentAfterReconciliation,
  restoreMaintenanceCheckpoint,
  upgradeWithCoordinatedCheckpoint,
  type CoordinatedMaintenanceServices,
} from "./coordinated-maintenance.js";
import { verifyCoordinatedCheckpoint } from "./coordinated-checkpoint.js";
import { reconcileCoordinatedState } from "./reconcile-coordinated-state.js";
import { stopForCoordinatedMaintenance } from "./coordinated-stop.js";
import type { DualServiceConfig } from "./dual-service.js";
import { isEntryModule, nodeHostOperations, type HostOperations } from "./host.js";

const systemctl = "/usr/bin/systemctl";
const serviceOrder = ["mate-control-plane.service", "mate-node.service"] as const;
const agentIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export interface DeploymentMaintenanceActions {
  backup(config: DualServiceConfig, destination?: string): Promise<unknown>;
  verify(config: DualServiceConfig, checkpoint: string): unknown;
  restore(config: DualServiceConfig, checkpoint: string): Promise<unknown>;
  reconcile(config: DualServiceConfig): unknown;
  releaseAgent(config: DualServiceConfig, agentId: string): unknown;
  upgrade(config: DualServiceConfig, releasePath: string): Promise<unknown>;
}

export interface DeploymentCliDependencies {
  readConfig?: (path: string) => DualServiceConfig;
  doctor?: (config: DualServiceConfig) => unknown;
  install?: (config: DualServiceConfig, release: string) => unknown;
  maintenance?: DeploymentMaintenanceActions;
  host?: HostOperations;
  write?: (text: string) => void;
}

/** The only supported first-release installer operates the control plane and Linux node separately. */
export async function deploymentMain(
  args = process.argv.slice(2),
  dependencies: DeploymentCliDependencies = {},
): Promise<void> {
  const [action, configPath, value] = args;
  const readConfig = dependencies.readConfig ?? readDualServiceConfig;
  const write = dependencies.write ?? ((text) => process.stdout.write(text));
  if (action === "doctor" && args.length === 2 && configPath) {
    writeJson(write, (dependencies.doctor ?? dualServiceDoctor)(readConfig(configPath)));
    return;
  }
  if (action === "install" && args.length === 3 && configPath && value) {
    writeJson(
      write,
      (dependencies.install ?? ((config, release) => installDualService(config, release, false)))(
        readConfig(configPath),
        value,
      ),
    );
    return;
  }
  if (action === "upgrade" && args.length === 3 && configPath && value) {
    const config = readConfig(configPath);
    writeJson(
      write,
      await (dependencies.maintenance ?? defaultMaintenance(dependencies.host)).upgrade(
        config,
        value,
      ),
    );
    return;
  }
  if (
    configPath &&
    action &&
    ["backup", "verify", "restore", "reconcile", "release-agent"].includes(action)
  ) {
    const config = readConfig(configPath);
    const maintenance = dependencies.maintenance ?? defaultMaintenance(dependencies.host);
    if (action === "backup" && (args.length === 2 || args.length === 3)) {
      writeJson(write, await maintenance.backup(config, value));
      return;
    }
    if (action === "verify" && args.length === 3 && value) {
      writeJson(write, maintenance.verify(config, value));
      return;
    }
    if (action === "restore" && args.length === 3 && value) {
      writeJson(write, await maintenance.restore(config, value));
      return;
    }
    if (action === "reconcile" && args.length === 2) {
      writeJson(write, maintenance.reconcile(config));
      return;
    }
    if (action === "release-agent" && args.length === 3 && value && agentIdPattern.test(value)) {
      writeJson(write, maintenance.releaseAgent(config, value));
      return;
    }
  }
  throw new Error(
    "Usage: mate-deploy install|upgrade CONFIG RELEASE; doctor CONFIG; backup CONFIG [CHECKPOINT]; verify CONFIG CHECKPOINT; restore CONFIG CHECKPOINT; reconcile CONFIG; release-agent CONFIG AGENT_ID",
  );
}

function defaultMaintenance(hostInput?: HostOperations): DeploymentMaintenanceActions {
  const host = hostInput ?? nodeHostOperations();
  return {
    async backup(config, destination) {
      requireLinuxRoot(host);
      const checkpoint = destination ?? newCheckpointPath();
      const manifest = await createMaintenanceBackup(
        statePaths(config),
        checkpoint,
        systemdServices(host),
      );
      return { checkpoint, id: manifest.id, entries: manifest.entries.length };
    },
    verify(config, checkpoint) {
      requireLinuxRoot(host);
      void config;
      return verifyCoordinatedCheckpoint(checkpoint);
    },
    async restore(config, checkpoint) {
      requireLinuxRoot(host);
      const paths = statePaths(config);
      return restoreMaintenanceCheckpoint(checkpoint, paths, systemdServices(host), () =>
        reconcileCoordinatedState(paths),
      );
    },
    reconcile(config) {
      requireLinuxRoot(host);
      const paths = statePaths(config);
      return reconcileDuringMaintenance(systemdServices(host), () =>
        reconcileCoordinatedState(paths),
      );
    },
    releaseAgent(config, agentId) {
      requireLinuxRoot(host);
      const paths = statePaths(config);
      return releaseAgentAfterReconciliation(agentId, () =>
        reconcileDuringMaintenance(systemdServices(host), () => reconcileCoordinatedState(paths)),
      );
    },
    async upgrade(config, releasePath) {
      requireLinuxRoot(host);
      const checkpoint = newCheckpointPath();
      const result = await upgradeWithCoordinatedCheckpoint(
        statePaths(config),
        checkpoint,
        systemdServices(host),
        () => installDualService(config, releasePath, true),
      );
      return {
        ...result.result,
        checkpoint: result.manifest.id,
        checkpointPath: checkpoint,
      };
    },
  };
}

function statePaths(config: DualServiceConfig) {
  return {
    controlPlaneDataDir: config.controlPlaneDataDir,
    nodeDataDir: config.nodeDataDir,
    agentHomeRoot: config.agentHomeRoot,
  };
}

function systemdServices(host: HostOperations): CoordinatedMaintenanceServices {
  let previouslyActive: Map<(typeof serviceOrder)[number], boolean> | undefined;
  return {
    stop() {
      if (!previouslyActive) {
        const states = new Map<(typeof serviceOrder)[number], boolean>();
        for (const unit of serviceOrder) {
          const result = host.run(systemctl, ["show", unit, "-p", "ActiveState", "--value"]);
          if (result.code !== 0 || !["active", "inactive", "failed"].includes(result.stdout.trim()))
            throw new Error(`Cannot determine whether ${unit} is active`);
          states.set(unit, result.stdout.trim() === "active");
        }
        previouslyActive = states;
      }
      stopForCoordinatedMaintenance(host);
    },
    resume() {
      if (!previouslyActive) throw new Error("Prior service state was not captured");
      for (const unit of serviceOrder) {
        if (!previouslyActive.get(unit)) continue;
        const result = host.run(systemctl, ["start", unit], { timeoutMs: 30_000 });
        if (result.code !== 0)
          throw new Error(`Cannot restart ${unit}: ${result.stderr.slice(0, 200)}`);
        const state = host.run(systemctl, ["show", unit, "-p", "ActiveState", "--value"]);
        if (state.code !== 0 || state.stdout.trim() !== "active")
          throw new Error(`${unit} did not return to its previous active state`);
      }
    },
  };
}

function newCheckpointPath(): string {
  const root = "/var/backups/mate";
  for (let parent = root; parent !== "/"; parent = dirname(parent))
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
      throw new Error(`Checkpoint path contains symbolic link: ${parent}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0)
    throw new Error("Default checkpoint directory must be a real root-owned directory");
  chmodSync(root, 0o700);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(root, `${timestamp}-${randomUUID()}`);
}

function requireLinuxRoot(host: HostOperations): void {
  if (host.platform !== "linux" || host.euid() !== 0)
    throw new Error("Coordinated maintenance requires Linux root");
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
