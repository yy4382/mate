import {
  accessSync,
  constants,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { bundleEntrypoints, releaseVersion } from "../bundle.js";
import { readNodeConfiguration } from "../configuration.js";
import {
  checkManagedDirectory,
  installedEntryVersion,
  lstatIfPresent,
  prepareManagedDirectory,
  requireOrdinaryAccount,
  withManagementLock,
} from "../install-entry.js";
import { nodePaths } from "../paths.js";
import {
  nodeUnitName,
  systemdUserManager,
  type UserServiceManager,
  type InspectionOptions,
} from "./systemd.js";
import { createAtomicNoReplaceRename } from "../../files/mutations/atomic-rename.js";

export const nodeServiceCommands = ["install", "start", "stop", "restart", "status", "logs"];
const quote = (value: string) => {
  if (/[\r\n\0]/.test(value))
    throw new Error("Service paths cannot contain newline or NUL characters");
  return JSON.stringify(value.replaceAll("%", "%%"));
};
export function renderNodeUnit(paths: ReturnType<typeof nodePaths>, version: string) {
  const entries = bundleEntrypoints(join(paths.versionsDirectory, releaseVersion.parse(version)));
  // ':' disables environment substitution in literal absolute arguments; quote also escapes '%'.
  // WorkingDirectory is a scalar, not an ExecStart word; '~' selects this account's home.
  return `# Mate node service\n# Mate bundle version: ${version}\n[Unit]\nDescription=Mate Linux node\n\n[Service]\nType=exec\nExecStart=:${quote(entries.runtime)} ${quote(entries.node)} --config-file ${quote(paths.configuration)}\nUnsetEnvironment=GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN\nWorkingDirectory=~\nRestart=on-failure\nRestartSec=5s\nKillMode=mixed\nTimeoutStopSec=45s\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}

export function recoverUnitStaging(paths: ReturnType<typeof nodePaths>, version: string) {
  if (!lstatIfPresent(dirname(paths.unit))) return;
  const expected = renderNodeUnit(paths, version);
  for (const name of readdirSync(dirname(paths.unit))) {
    if (
      !/^\.mate-node-unit-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name)
    )
      continue;
    const file = join(dirname(paths.unit), name),
      info = lstatIfPresent(file);
    if (
      !info?.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      !expected.startsWith(readFileSync(file, "utf8"))
    )
      throw new Error(`Unknown interrupted user unit file was preserved: ${file}`);
    rmSync(file);
  }
}

function readManagedUnitFile(paths: ReturnType<typeof nodePaths>, file: string) {
  const info = lstatIfPresent(file);
  if (!info) return undefined;
  if (!info.isFile() || info.uid !== process.getuid?.())
    throw new Error(`Non-Mate user unit conflict: ${file}`);
  const text = readFileSync(file, "utf8"),
    version = text.match(/^# Mate bundle version: (.+)$/m)?.[1];
  if (
    !version ||
    !releaseVersion.safeParse(version).success ||
    text !== renderNodeUnit(paths, version)
  )
    throw new Error(
      `Non-Mate or modified user unit conflict: ${file}; keep custom service environment in a systemd drop-in`,
    );
  return version;
}

export function readManagedUnit(paths: ReturnType<typeof nodePaths>) {
  return readManagedUnitFile(paths, paths.unit);
}

/** A moved unit is its own ownership evidence, not a persisted maintenance intent. */
export function interruptedUnitFiles(paths: ReturnType<typeof nodePaths>) {
  if (!lstatIfPresent(dirname(paths.unit))) return [];
  return readdirSync(dirname(paths.unit))
    .filter((name) =>
      /^\.mate-node-previous-unit-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        name,
      ),
    )
    .map((name) => {
      const file = join(dirname(paths.unit), name);
      return { file, version: readManagedUnitFile(paths, file) };
    });
}

export function publishNodeUnit(
  paths: ReturnType<typeof nodePaths>,
  version: string,
  oldVersion: string | undefined,
  bundleDirectory: string,
) {
  const noReplace = createAtomicNoReplaceRename(
    join(bundleDirectory, "app/apps/node/dist/files/rename-noreplace"),
  );
  const temporary = join(dirname(paths.unit), `.mate-node-unit-${randomUUID()}`);
  const previous = join(dirname(paths.unit), `.mate-node-previous-unit-${randomUUID()}`);
  try {
    writeFileSync(temporary, renderNodeUnit(paths, version), { mode: 0o600, flag: "wx" });
    if (oldVersion !== undefined) {
      noReplace(paths.unit, previous);
      if (readManagedUnitFile(paths, previous) !== oldVersion)
        throw new Error(
          `Concurrent user unit was preserved at ${previous}; resolve it before retrying update`,
        );
    }
    noReplace(temporary, paths.unit);
    for (const backup of interruptedUnitFiles(paths)) rmSync(backup.file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function prepareNodeDirectories(
  paths: ReturnType<typeof nodePaths>,
  config: ReturnType<typeof readNodeConfiguration>,
) {
  const canonicalPath = (path: string) => {
    let ancestor = resolve(path);
    const missing = [];
    while (!lstatIfPresent(ancestor)) {
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
    return join(realpathSync(ancestor), ...missing);
  };
  const nested = (parent: string, path: string) => {
    const part = relative(canonicalPath(parent), canonicalPath(path));
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

function report(
  paths: ReturnType<typeof nodePaths>,
  version: string,
  manager: UserServiceManager,
  options?: InspectionOptions,
) {
  const config = readNodeConfiguration(paths.configuration, paths),
    facts = manager.inspect(options);
  return `Mate bundle: ${version}\nUnit bundle: ${readManagedUnit(paths) ?? "not installed"}\nUnit: ${paths.unit}\nConfiguration: ${paths.configuration}\nData: ${config.dataDirectory}\nAgent workspaces: ${config.agentWorkspaceRoot}\nControl plane: ${config.controlPlaneUrl}\nUser manager: available\nService: ${nodeUnitName}\nLoaded: ${facts.load}\nEnabled: ${facts.enabled || "unknown"}\nActive: ${facts.active} (${facts.sub}); PID: ${facts.pid}\nLinger: ${manager.linger()} (enable does not provide login-independent startup; Mate never changes linger)\nService active does not establish pairing or online status. Check the web interface and mate node logs.\n`;
}

export function serviceReferencesBundle(
  facts: ReturnType<UserServiceManager["inspect"]>,
  paths: ReturnType<typeof nodePaths>,
  version: string,
) {
  const entries = bundleEntrypoints(join(paths.versionsDirectory, version)),
    command = facts.execStart[0];
  return (
    facts.type === "exec" &&
    facts.execStart.length === 1 &&
    command?.flags.length === 1 &&
    command.flags[0] === "no-env-expand" &&
    command?.path === entries.runtime &&
    JSON.stringify(command.argv) ===
      JSON.stringify([entries.runtime, entries.node, "--config-file", paths.configuration])
  );
}

/** Public command boundary; a manager replacement is only for early branch tests. */
export async function manageNode(
  command: string,
  paths: ReturnType<typeof nodePaths>,
  bundleDirectory: string,
  version: string,
  manager = systemdUserManager,
  logOptions = { lines: 100, follow: false },
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
    const unitVersion = readManagedUnit(paths),
      facts = manager.inspect(inspection);
    if (facts.load !== "not-found" && facts.fragment !== paths.unit)
      throw new Error(`Non-Mate manager unit conflicts with ${paths.unit}`);
    if (command === "status") {
      const output = report(paths, version, manager);
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
      if (
        !Number.isSafeInteger(logOptions.lines) ||
        logOptions.lines < 0 ||
        logOptions.lines > 100_000
      )
        throw new Error("Use --lines with an integer from 0 to 100000");
      if (manager.logs(logOptions.lines, logOptions.follow) !== 0)
        throw new Error("User journal command failed");
      return "";
    }
    if (command === "install") {
      if (unitVersion && unitVersion !== version)
        throw new Error("Existing service uses another version; use mate node update");
      if (!lstatIfPresent(paths.configuration)) {
        prepareManagedDirectory(paths.configDirectory);
        writeFileSync(
          paths.configuration,
          `${JSON.stringify({ MATE_CONTROL_PLANE_URL: "http://127.0.0.1:8787", MATE_NODE_DATA_DIR: paths.dataDirectory, MATE_NODE_AGENT_WORKSPACE_ROOT: join(paths.dataDirectory, "agents") }, null, 2)}\n`,
          { mode: 0o600, flag: "wx" },
        );
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
      return `${report(paths, version, manager)}Existing stopped/disabled units are preserved. Use mate node start to start explicitly.\n`;
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
      return report(paths, version, manager, inspection);
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
