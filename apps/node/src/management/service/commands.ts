import { accessSync, constants, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { readNodeConfiguration } from "../configuration.js";
import {
  checkManagedDirectory,
  installedEntryVersion,
  prepareManagedDirectory,
  requireOrdinaryAccount,
  withManagementLock,
} from "../install-entry.js";
import { canonicalManagedPath, lstatIfPresent, nodePaths } from "../paths.js";
import {
  nodeUnitName,
  systemdUserManager,
  type UserServiceManager,
  type InspectionOptions,
} from "./systemd.js";
import {
  readManagedUnit,
  recoverUnitStaging,
  renderNodeUnit,
  serviceReferencesBundle,
} from "./unit.js";
import { createAtomicNoReplaceRename } from "../../files/mutations/atomic-rename.js";

export const nodeServiceCommands = ["install", "start", "stop", "restart", "status", "logs"];
function prepareNodeDirectories(
  paths: ReturnType<typeof nodePaths>,
  config: ReturnType<typeof readNodeConfiguration>,
) {
  const nested = (parent: string, path: string) => {
    const part = relative(canonicalManagedPath(parent), canonicalManagedPath(path));
    return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
  };
  for (const path of [config.dataDirectory, config.agentWorkspaceRoot]) {
    if (
      [
        paths.programDirectory,
        paths.configDirectory,
        dirname(paths.unit),
        dirname(paths.entry),
      ].some((reserved) => nested(reserved, path) || nested(path, reserved))
    )
      throw new Error(
        "Node data/workspace directories must be separate from managed program, configuration and service directories",
      );
    prepareManagedDirectory(path);
    checkManagedDirectory(path);
    accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
  }
  if ((lstatIfPresent(config.dataDirectory)!.mode & 0o077) !== 0)
    throw new Error("Node data directory must be private (0700)");
}

function renderServiceReport(
  paths: ReturnType<typeof nodePaths>,
  version: string,
  manager: UserServiceManager,
  options?: InspectionOptions,
) {
  const config = readNodeConfiguration(paths.configuration, paths);
  const facts = manager.inspect(options);
  return `Mate bundle: ${version}
Unit bundle: ${readManagedUnit(paths) ?? "not installed"}
Unit: ${paths.unit}
Configuration: ${paths.configuration}
Data: ${config.dataDirectory}
Agent workspaces: ${config.agentWorkspaceRoot}
Control plane: ${config.controlPlaneUrl}
User manager: available
Service: ${nodeUnitName}
Loaded: ${facts.load}
Enabled: ${facts.enabled || "unknown"}
Active: ${facts.active} (${facts.sub}); PID: ${facts.pid}
Linger: ${manager.linger()} (enable does not provide login-independent startup; Mate never changes linger)
Service active does not establish pairing or online status. Check the web interface and mate node logs.
`;
}

/** Execute one service command against the selected installed bundle. */
export async function manageNode(
  command: string,
  {
    paths,
    bundleDirectory,
    version,
    logs = { lines: 100, follow: false },
  }: {
    paths: ReturnType<typeof nodePaths>;
    bundleDirectory: string;
    version: string;
    logs?: { lines: number; follow: boolean };
  },
  manager = systemdUserManager,
) {
  requireOrdinaryAccount();
  const inspection = { effectiveCommand: command !== "stop" && command !== "logs" };
  manager.assertAvailable(inspection);
  const perform = () => {
    const selected = installedEntryVersion(paths);
    if (
      selected !== version ||
      realpathSync(bundleDirectory) !== realpathSync(join(paths.versionsDirectory, version))
    )
      throw new Error(
        "Management entry and running complete bundle differ; use mate node update to diagnose the installed version",
      );
    const unitVersion = readManagedUnit(paths);
    const facts = manager.inspect(inspection);
    if (facts.load !== "not-found" && facts.fragment !== paths.unit)
      throw new Error(`Non-Mate manager unit conflicts with ${paths.unit}`);
    if (command === "status") {
      const output = renderServiceReport(paths, version, manager);
      if (
        !unitVersion ||
        unitVersion !== version ||
        facts.load !== "loaded" ||
        facts.needsReload ||
        !serviceReferencesBundle(facts, paths, version)
      )
        throw new Error(
          `${output}Installation is incomplete or unit/bundle references differ; run mate node install for this version or mate node update to repair.\n`,
        );
      return output;
    }
    if (command === "logs") {
      if (!unitVersion) throw new Error("Mate user service is not installed");
      if (!Number.isSafeInteger(logs.lines) || logs.lines < 0 || logs.lines > 100_000)
        throw new Error("Use --lines with an integer from 0 to 100000");
      if (manager.logs(logs.lines, logs.follow) !== 0)
        throw new Error("User journal command failed");
      return "";
    }
    if (command === "install") {
      if (unitVersion && unitVersion !== version)
        throw new Error("Existing service uses another version; use mate node update");
      if (!lstatIfPresent(paths.configuration)) {
        prepareManagedDirectory(paths.configDirectory);
        const initialConfiguration = {
          MATE_CONTROL_PLANE_URL: "http://127.0.0.1:8787",
          MATE_NODE_DATA_DIR: paths.dataDirectory,
          MATE_NODE_AGENT_WORKSPACE_ROOT: join(paths.dataDirectory, "agents"),
        };
        writeFileSync(paths.configuration, `${JSON.stringify(initialConfiguration, null, 2)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
      }
      const config = readNodeConfiguration(paths.configuration, paths);
      if (!lstatIfPresent(join(config.dataDirectory, "node-identity.json")) && !config.pairingToken)
        throw new Error(
          `Prepare a web pairing token in private ${paths.configuration} before first install`,
        );
      prepareNodeDirectories(paths, config);
      recoverUnitStaging(paths, version);
      if (!unitVersion) {
        prepareManagedDirectory(dirname(paths.unit));
        const temporary = join(dirname(paths.unit), `.mate-node-unit-${randomUUID()}`);
        try {
          writeFileSync(temporary, renderNodeUnit(paths, version), { mode: 0o600, flag: "wx" });
          createAtomicNoReplaceRename(
            join(bundleDirectory, "app/apps/node/dist/files/rename-noreplace"),
          )(temporary, paths.unit);
        } finally {
          rmSync(temporary, { force: true });
        }
        manager.run("daemon-reload");
        if (!serviceReferencesBundle(manager.inspect(), paths, version))
          throw new Error(
            "Effective user service command/configuration references differ; resolve the systemd drop-in before starting",
          );
        manager.run("enable");
        manager.run("start");
      } else {
        manager.run("daemon-reload");
        if (!serviceReferencesBundle(manager.inspect(), paths, version))
          throw new Error(
            "Effective user service command/configuration references differ; resolve the systemd drop-in before starting",
          );
      }
      return `${renderServiceReport(paths, version, manager)}Existing stopped/disabled units are preserved. Use mate node start to start explicitly.\n`;
    }
    if (
      !unitVersion ||
      facts.load !== "loaded" ||
      (command !== "stop" &&
        (unitVersion !== version ||
          facts.needsReload ||
          !serviceReferencesBundle(facts, paths, version)))
    )
      throw new Error(
        "Service and complete bundle references are incomplete or differ; run mate node install/update before starting",
      );
    if (command === "start" || command === "restart") {
      const config = readNodeConfiguration(paths.configuration, paths);
      prepareNodeDirectories(paths, config);
    }
    if (command !== "start" && command !== "stop" && command !== "restart")
      throw new Error("Unknown node service command");
    manager.run(command);
    try {
      return renderServiceReport(paths, version, manager, inspection);
    } catch (error) {
      throw new Error(
        `User service ${command} completed; status unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  };
  return command === "status" || command === "logs"
    ? perform()
    : withManagementLock(paths, perform);
}
