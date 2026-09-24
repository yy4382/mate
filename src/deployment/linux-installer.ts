import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  chownSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { daemonConfigSchema, sameConfiguration, type DaemonConfig } from "../daemon/config.js";
import { createReleaseManifest, verifyRelease } from "./release.js";
import { createLinuxDeploymentPlan, type LinuxDeploymentPlan } from "./linux-plan.js";
import { managedLayout } from "./systemd.js";
import type { DeploymentSpec } from "./spec.js";
import { nodeLinuxInstallerHost, type LinuxInstallerHost } from "./linux-host.js";
import { runDoctor } from "./doctor.js";
import { LinuxProcessManager } from "../execution/linux-processes.js";
import { initialMemory } from "../agents/workspace.js";

export function renderLinuxService(plan: LinuxDeploymentPlan): string {
  return `[Unit]\nDescription=Mate autonomous Agent daemon\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=notify\nNotifyAccess=all\nUser=root\nGroup=root\nWorkingDirectory=${managedLayout.current}\nEnvironmentFile=${managedLayout.environment}\nExecStart=/usr/bin/node ${managedLayout.current}/dist/src/main.js start ${managedLayout.config}\nRestart=on-failure\nRestartSec=5\nTimeoutStartSec=900\nTimeoutStopSec=120\nKillMode=mixed\nMemoryMax=${plan.daemonMemoryMiB}M\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`;
}
export function renderAgentSlice(): string {
  return "[Unit]\nDescription=Mate Agent process quota\n\n[Slice]\nMemoryMax=256M\nTasksMax=128\nCPUQuota=100%\n";
}
function renderParentSlice(): string {
  return "[Unit]\nDescription=Mate Agent process hierarchy\n\n[Slice]\n";
}
export function renderLinuxMaintenanceWrapper(): string {
  return `#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
[ "$(id -u)" -eq 0 ] || { echo "matectl requires root" >&2; exit 1; }
case "\${1-}" in
  status|logs)
    [ "$#" -eq 1 ] || { echo "Read-only command takes no arguments" >&2; exit 1; }
    exec /usr/bin/node /opt/mate/current/dist/src/deployment/cli.js "$1" ;;
  doctor)
    [ "$#" -eq 1 ] || { echo "Command takes no arguments" >&2; exit 1; }
    exec /usr/bin/systemd-run --quiet --collect --wait --pipe --property=EnvironmentFile=/etc/mate/mate.env \
      /usr/bin/node /opt/mate/current/dist/src/main.js doctor /etc/mate/mate.json ;;
  offline-probe)
    [ "$#" -eq 1 ] || { echo "Command takes no arguments" >&2; exit 1; }
    exec /usr/bin/node /opt/mate/current/dist/src/main.js "$1" /etc/mate/mate.json ;;
  upgrade)
    [ "$#" -eq 2 ] || { echo "Usage: matectl upgrade SPEC" >&2; exit 1; }
    exec /usr/bin/node /opt/mate/current/dist/src/deployment/cli.js upgrade "$2" ;;
  rollback|finalize)
    [ "$#" -eq 1 ] || { echo "Command takes no arguments" >&2; exit 1; }
    exec /usr/bin/node /opt/mate/controller/dist/src/deployment/cli.js "$1" ;;
  backup)
    [ "$#" -eq 2 ] || { echo "Usage: matectl backup NAME" >&2; exit 1; }
    case "$2" in ''|*[!A-Za-z0-9._-]*|.*|-*) echo "Invalid checkpoint name" >&2; exit 1;; esac
    [ "\${#2}" -le 64 ] || exit 1
    exec /usr/bin/node /opt/mate/current/dist/src/main.js backup /etc/mate/mate.json "/var/backups/mate/$2" ;;
  restore)
    [ "$#" -eq 2 ] || [ "$#" -eq 4 ] || { echo "Usage: matectl restore NAME [--replace CURRENT]" >&2; exit 1; }
    case "$2" in ''|*[!A-Za-z0-9._-]*|.*|-*) echo "Invalid checkpoint name" >&2; exit 1;; esac
    [ "\${#2}" -le 64 ] || exit 1
    if [ "$#" -eq 4 ]; then
      [ "$3" = --replace ] || exit 1
      case "$4" in ''|*[!A-Za-z0-9._-]*|.*|-*) echo "Invalid checkpoint name" >&2; exit 1;; esac
      [ "\${#4}" -le 64 ] || exit 1
      exec /usr/bin/node /opt/mate/current/dist/src/main.js restore /etc/mate/mate.json "/var/backups/mate/$2" --replace "/var/backups/mate/$4"
    fi
    exec /usr/bin/node /opt/mate/current/dist/src/main.js restore /etc/mate/mate.json "/var/backups/mate/$2" ;;
  *) echo "Usage: matectl status|logs|doctor|offline-probe|upgrade SPEC|rollback|finalize|backup NAME|restore NAME [--replace CURRENT]" >&2; exit 1;;
esac
`;
}

function checked(host: LinuxInstallerHost, binary: string, args: string[], label: string): string {
  const result = host.run(binary, args);
  if (result.code !== 0)
    throw new Error(`${label}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  return result.stdout.trim();
}
function exactDirectory(path: string, uid: number, gid: number, mode: number): void {
  if (!existsSync(path)) {
    mkdirSync(path);
    chownSync(path, uid, gid);
    chmodSync(path, mode);
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== uid ||
    stat.gid !== gid ||
    (stat.mode & 0o777) !== mode
  )
    throw new Error(`Managed directory differs: ${path}`);
}
function exactFile(path: string, text: string, uid: number, gid: number, mode: number): void {
  if (!existsSync(path)) {
    writeFileSync(path, text, { flag: "wx", mode });
    chownSync(path, uid, gid);
    chmodSync(path, mode);
  }
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== uid ||
    stat.gid !== gid ||
    (stat.mode & 0o777) !== mode ||
    readFileSync(path, "utf8") !== text
  )
    throw new Error(`Managed file differs: ${path}`);
}
function account(host: LinuxInstallerHost, agent: LinuxDeploymentPlan["agents"][number]): void {
  const entry = checked(
    host,
    "/usr/bin/getent",
    ["passwd", agent.username],
    `Cannot find ${agent.agentId} account`,
  ).split(":");
  if (
    entry.length !== 7 ||
    Number(entry[2]) !== agent.uid ||
    Number(entry[3]) !== agent.gid ||
    entry[5] !== agent.home
  )
    throw new Error(`${agent.agentId}: configured UID, GID or home differs from passwd`);
  const groups = checked(
    host,
    "/usr/bin/id",
    ["-G", agent.username],
    `Cannot inspect ${agent.agentId} groups`,
  )
    .split(/\s+/)
    .map(Number);
  if (groups.some((group) => group === 0 || group !== agent.gid))
    throw new Error(`${agent.agentId}: account has unexpected supplementary groups`);
}
async function publishLinuxRelease(
  plan: LinuxDeploymentPlan,
  host: LinuxInstallerHost,
): Promise<{ release: string; releaseId: string }> {
  const stage = join(managedLayout.releases, `.linux-stage-${randomUUID()}`);
  mkdirSync(stage, { mode: 0o755 });
  try {
    for (const name of ["dist", "node_modules", "package.json", "pnpm-lock.yaml"])
      checked(
        host,
        "/usr/bin/cp",
        [
          "-a",
          "--no-preserve=xattr,context",
          join(realpathSync(plan.release.source), name),
          join(stage, name),
        ],
        `Cannot copy ${name}`,
      );
    checked(host, "/usr/bin/chown", ["-hR", "root:root", stage], "Cannot seal release owner");
    checked(
      host,
      "/usr/bin/chmod",
      ["-R", "u-s,g-s", stage],
      "Cannot strip privileged release modes",
    );
    checked(host, "/usr/bin/chmod", ["-R", "go-w", stage], "Cannot seal release modes");
    const manifest = await createReleaseManifest(stage, plan.release.gitCommit);
    exactFile(join(stage, "RELEASE.json"), `${JSON.stringify(manifest, null, 2)}\n`, 0, 0, 0o444);
    const release = join(managedLayout.releases, manifest.releaseId);
    if (existsSync(release)) await verifyRelease(release, manifest.releaseId);
    else renameSync(stage, release);
    return { release, releaseId: manifest.releaseId };
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true });
  }
}
export function preflightLinuxDeployment(
  spec: DeploymentSpec,
  config: DaemonConfig,
  host: LinuxInstallerHost,
): LinuxDeploymentPlan {
  const plan = createLinuxDeploymentPlan(spec, config, host);
  const os = Object.fromEntries(
    host
      .read("/etc/os-release")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, "")];
      }),
  );
  if (
    host.platform !== "linux" ||
    host.arch !== "x64" ||
    !/^v24\./.test(host.node) ||
    os.ID !== "debian" ||
    os.VERSION_ID !== "13"
  )
    throw new Error("Linux deployment requires Debian 13 x86_64 and Node 24");
  for (const binary of [
    "/usr/bin/systemctl",
    "/usr/bin/systemd-run",
    "/usr/bin/setpriv",
    "/usr/bin/getent",
    "/usr/bin/id",
    "/usr/bin/node",
    "/usr/bin/cp",
    "/usr/bin/chown",
    "/usr/bin/chmod",
  ])
    host.assertRootExecutable(binary);
  const installedNode = checked(
    host,
    "/usr/bin/node",
    ["--version"],
    "Cannot inspect service Node",
  );
  if (installedNode !== host.node)
    throw new Error(
      `Deployment Node ${host.node} differs from fixed service Node ${installedNode}`,
    );
  for (const agent of plan.agents) account(host, agent);
  if (host.availableBytes("/") < plan.requiredBytes)
    throw new Error(`Insufficient free disk space: ${plan.requiredBytes} bytes required`);
  if (host.memoryMiB() < plan.daemonMemoryMiB + 256)
    throw new Error("Host memory is below the daemon plus one Agent process quota");
  if (host.run("/usr/bin/systemctl", ["is-active", "--quiet", "mate.service"]).code === 0)
    throw new Error("Stop mate.service before installation");
  return plan;
}

export async function installLinuxDeployment(
  spec: DeploymentSpec,
  config: DaemonConfig,
  host: LinuxInstallerHost,
): Promise<{ plan: LinuxDeploymentPlan; releaseId: string; serviceStarted: false }> {
  if (host.euid() !== 0) throw new Error("Linux deployment installation must run as root");
  const plan = preflightLinuxDeployment(spec, config, host);
  exactDirectory("/opt/mate", 0, 0, 0o755);
  exactDirectory(managedLayout.releases, 0, 0, 0o755);
  exactDirectory(managedLayout.configDir, 0, 0, 0o700);
  exactDirectory(managedLayout.data, 0, 0, 0o700);
  for (const part of ["state", "control"])
    exactDirectory(join(managedLayout.data, part), 0, 0, 0o700);
  exactDirectory("/var/backups", 0, 0, 0o755);
  exactDirectory(managedLayout.checkpoints, 0, 0, 0o700);
  exactDirectory(dirname(plan.sharedRoot), 0, 0, 0o755);
  exactDirectory(plan.sharedRoot, 0, 0, 0o755);
  for (const agent of plan.agents) {
    exactDirectory(dirname(agent.home), 0, 0, 0o755);
    exactDirectory(agent.home, agent.uid, agent.gid, 0o700);
    const definition = config.mate.agents.find((item) => item.id === agent.agentId)!;
    const memory = join(agent.home, "MEMORY.md");
    if (!existsSync(memory)) {
      for (const name of ["notes", "artifacts"])
        exactDirectory(join(agent.home, name), agent.uid, agent.gid, 0o700);
      exactFile(memory, initialMemory(definition.name), agent.uid, agent.gid, 0o600);
    } else {
      const stat = lstatSync(memory);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== agent.uid ||
        stat.gid !== agent.gid ||
        (stat.mode & 0o777) !== 0o600
      )
        throw new Error(`Private memory ownership differs: ${memory}`);
    }
    exactDirectory(join(plan.sharedRoot, agent.agentId), agent.uid, agent.gid, 0o755);
  }
  const { release, releaseId } = await publishLinuxRelease(plan, host);
  const configText = `${JSON.stringify(config, null, 2)}\n`,
    envText = plan.environmentSource ? host.read(plan.environmentSource) : "";
  exactFile(managedLayout.config, configText, 0, 0, 0o600);
  exactFile(managedLayout.environment, envText, 0, 0, 0o600);
  for (const parent of ["mate.slice", "mate-agent.slice"])
    exactFile(join("/etc/systemd/system", parent), renderParentSlice(), 0, 0, 0o644);
  for (const agent of plan.agents)
    exactFile(join("/etc/systemd/system", agent.slice), renderAgentSlice(), 0, 0, 0o644);
  exactFile(managedLayout.service, renderLinuxService(plan), 0, 0, 0o644);
  exactFile(managedLayout.wrapper, renderLinuxMaintenanceWrapper(), 0, 0, 0o755);
  for (const link of [managedLayout.current, managedLayout.controller]) {
    if (existsSync(link)) {
      if (realpathSync(link) !== release) throw new Error(`Existing release link differs: ${link}`);
    } else checked(host, "/usr/bin/ln", ["-s", release, link], `Cannot publish ${link}`);
  }
  checked(host, "/usr/bin/systemctl", ["daemon-reload"], "Cannot reload systemd");
  for (const parent of ["mate.slice", "mate-agent.slice"])
    checked(host, "/usr/bin/systemctl", ["start", parent], `Cannot start ${parent}`);
  for (const agent of plan.agents)
    checked(host, "/usr/bin/systemctl", ["start", agent.slice], `Cannot start ${agent.slice}`);
  checked(
    host,
    "/usr/bin/systemctl",
    ["disable", "--now", "mate.service"],
    "Cannot leave Mate stopped for credential setup",
  );
  return { plan, releaseId, serviceStarted: false };
}

export function disableLinuxDeployment(
  config: DaemonConfig,
  host: LinuxInstallerHost = nodeLinuxInstallerHost(),
): void {
  if (host.euid() !== 0 || !config.runtime.linuxUsers)
    throw new Error("Linux deployment disable requires root and Linux identities");
  checked(
    host,
    "/usr/bin/systemctl",
    ["disable", "--now", "mate.service"],
    "Cannot stop Mate service",
  );
  // Stopping Mate does not silently kill Agent-owned background work; owners may inspect/stop it separately.
}

const linuxUpgradeJournal = join(managedLayout.data, "control", "linux-upgrade.json");
function inactiveAndIdle(config: DaemonConfig, host: LinuxInstallerHost): void {
  const service = host.run("/usr/bin/systemctl", [
    "show",
    "mate.service",
    "-p",
    "ActiveState",
    "--value",
  ]);
  if (service.code !== 0 || !["inactive", "failed"].includes(service.stdout.trim()))
    throw new Error("Stop mate.service before upgrade");
  const identities = config.runtime.linuxUsers!;
  const manager = new LinuxProcessManager(
    Object.fromEntries(Object.entries(identities).map(([id, user]) => [id, user.uid])),
  );
  for (const id of Object.keys(identities))
    if (manager.list(id).length) throw new Error(`Stop ${id} background tasks before upgrade`);
}
export function readLinuxUpgradeJournal(path = linuxUpgradeJournal): {
  oldRelease: string;
  newRelease: string;
} {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    stat.gid !== 0 ||
    (stat.mode & 0o777) !== 0o600
  )
    throw new Error("Linux upgrade journal is not root-only");
  const value = JSON.parse(readFileSync(path, "utf8")) as {
    oldRelease?: string;
    newRelease?: string;
  };
  for (const path of [value.oldRelease, value.newRelease])
    if (!path || !path.startsWith(`${managedLayout.releases}/`) || realpathSync(path) !== path)
      throw new Error("Linux upgrade release identity is invalid");
  return value as { oldRelease: string; newRelease: string };
}
function switchReleaseLink(link: string, target: string): void {
  const temporary = join("/opt/mate", `.release-link-${randomUUID()}`);
  symlinkSync(target, temporary);
  renameSync(temporary, link);
}
export async function upgradeLinuxDeployment(
  spec: DeploymentSpec,
  config: DaemonConfig,
  host: LinuxInstallerHost = nodeLinuxInstallerHost(),
): Promise<{ oldRelease: string; newRelease: string; serviceStarted: false }> {
  if (host.euid() !== 0) throw new Error("Linux upgrade requires root");
  const plan = preflightLinuxDeployment(spec, config, host);
  inactiveAndIdle(config, host);
  if (existsSync(linuxUpgradeJournal))
    throw new Error("Finish or roll back the previous upgrade first");
  const installed = daemonConfigSchema.parse(
    JSON.parse(readFileSync(managedLayout.config, "utf8")),
  );
  if (!sameConfiguration(installed, config))
    throw new Error(
      "Upgrade uses the installed configuration: stop Mate, write the new configuration to the managed configuration file, start it once so Mate applies the change, then upgrade",
    );
  if (
    plan.environmentSource &&
    host.read(plan.environmentSource) !== readFileSync(managedLayout.environment, "utf8")
  )
    throw new Error("Code upgrade cannot silently change credentials");
  const oldRelease = realpathSync(managedLayout.current);
  await verifyRelease(oldRelease);
  const { release: newRelease } = await publishLinuxRelease(plan, host);
  if (newRelease === oldRelease) throw new Error("Candidate is already the current release");
  const doctor = await runDoctor(config, undefined, {
    releaseRoot: newRelease,
    requireSecrets: false,
  });
  if (!doctor.healthy)
    throw new Error(
      `Candidate doctor failed: ${doctor.checks
        .filter((check) => check.status === "fail")
        .map((check) => check.name)
        .join(", ")}`,
    );
  exactFile(linuxUpgradeJournal, `${JSON.stringify({ oldRelease, newRelease })}\n`, 0, 0, 0o600);
  switchReleaseLink(managedLayout.current, newRelease);
  return { oldRelease, newRelease, serviceStarted: false };
}
export async function finishLinuxUpgrade(
  command: "rollback" | "finalize",
  host: LinuxInstallerHost = nodeLinuxInstallerHost(),
): Promise<void> {
  if (host.euid() !== 0) throw new Error("Linux upgrade maintenance requires root");
  const config = daemonConfigSchema.parse(JSON.parse(readFileSync(managedLayout.config, "utf8")));
  if (!config.runtime.linuxUsers) throw new Error("Linux identities are not configured");
  inactiveAndIdle(config, host);
  const journal = readLinuxUpgradeJournal();
  await verifyRelease(journal.oldRelease);
  await verifyRelease(journal.newRelease);
  const current = realpathSync(managedLayout.current);
  if (current !== journal.newRelease && current !== journal.oldRelease)
    throw new Error("Current release differs from the upgrade journal");
  // The controller remains pinned to the initially installed release, independent of candidate code.
  await verifyRelease(realpathSync(managedLayout.controller));
  if (command === "rollback") switchReleaseLink(managedLayout.current, journal.oldRelease);
  else if (current !== journal.newRelease) throw new Error("Cannot finalize a rolled-back upgrade");
  unlinkSync(linuxUpgradeJournal);
}
