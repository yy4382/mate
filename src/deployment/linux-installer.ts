import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { daemonConfigSchema, sameConfiguration, type DaemonConfig } from "../daemon/config.js";
import { createReleaseManifest, verifyRelease } from "./release.js";
import { createLinuxDeploymentPlan, type LinuxDeploymentPlan } from "./linux-plan.js";
import { managedLayout } from "./systemd.js";
import type { DeploymentSpec } from "./spec.js";
import { pathExists, type HostOperations } from "./host.js";
import {
  agentQuota,
  assertManagedEntry,
  ensureAgentWorkspace,
  ensureManagedDirectory,
  ensureManagedFile,
  hostProcessManager,
  hostRules,
  parentSliceUnits,
  type AgentIdentity,
  type ManagedEntry,
} from "./host-rules.js";
import { runDoctor } from "./doctor.js";
import { initialMemory } from "../agents/workspace.js";

export function renderLinuxService(plan: LinuxDeploymentPlan): string {
  return `[Unit]\nDescription=Mate autonomous Agent daemon\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=notify\nNotifyAccess=all\nUser=root\nGroup=root\nWorkingDirectory=${managedLayout.current}\nEnvironmentFile=${managedLayout.environment}\nExecStart=/usr/bin/node ${managedLayout.current}/dist/src/main.js start ${managedLayout.config}\nRestart=on-failure\nRestartSec=5\nTimeoutStartSec=900\nTimeoutStopSec=120\nKillMode=mixed\nMemoryMax=${plan.daemonMemoryMiB}M\nUMask=0077\n\n[Install]\nWantedBy=multi-user.target\n`;
}
export function renderAgentSlice(quota: typeof agentQuota = agentQuota): string {
  return `[Unit]\nDescription=Mate Agent process quota\n\n[Slice]\nMemoryMax=${quota.memoryMiB}M\nTasksMax=${quota.tasksMax}\nCPUQuota=${quota.cpuQuota}\n`;
}
function renderParentSlice(): string {
  return "[Unit]\nDescription=Mate Agent process hierarchy\n\n[Slice]\n";
}
export function renderLinuxMaintenanceWrapper(): string {
  // Every managed path in the generated wrapper comes from the one layout definition.
  const current = managedLayout.current,
    controller = managedLayout.controller,
    config = managedLayout.config,
    environment = managedLayout.environment,
    checkpoints = managedLayout.checkpoints;
  return `#!/bin/sh
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
[ "$(id -u)" -eq 0 ] || { echo "matectl requires root" >&2; exit 1; }
case "\${1-}" in
  status|logs)
    [ "$#" -eq 1 ] || { echo "Read-only command takes no arguments" >&2; exit 1; }
    exec /usr/bin/node ${current}/dist/src/deployment/cli.js "$1" ;;
  doctor)
    [ "$#" -eq 1 ] || { echo "Command takes no arguments" >&2; exit 1; }
    exec /usr/bin/systemd-run --quiet --collect --wait --pipe --property=EnvironmentFile=${environment} \
      /usr/bin/node ${current}/dist/src/main.js doctor ${config} ;;
  offline-probe)
    [ "$#" -eq 1 ] || { echo "Command takes no arguments" >&2; exit 1; }
    exec /usr/bin/node ${current}/dist/src/main.js "$1" ${config} ;;
  upgrade)
    [ "$#" -eq 2 ] || { echo "Usage: matectl upgrade SPEC" >&2; exit 1; }
    exec /usr/bin/node ${current}/dist/src/deployment/cli.js upgrade "$2" ;;
  rollback|finalize)
    [ "$#" -eq 1 ] || { echo "Command takes no arguments" >&2; exit 1; }
    exec /usr/bin/node ${controller}/dist/src/deployment/cli.js "$1" ;;
  backup)
    [ "$#" -eq 2 ] || { echo "Usage: matectl backup NAME" >&2; exit 1; }
    case "$2" in ''|*[!A-Za-z0-9._-]*|.*|-*) echo "Invalid checkpoint name" >&2; exit 1;; esac
    [ "\${#2}" -le 64 ] || exit 1
    exec /usr/bin/node ${current}/dist/src/main.js backup ${config} "${checkpoints}/$2" ;;
  restore)
    [ "$#" -eq 2 ] || [ "$#" -eq 4 ] || { echo "Usage: matectl restore NAME [--replace CURRENT]" >&2; exit 1; }
    case "$2" in ''|*[!A-Za-z0-9._-]*|.*|-*) echo "Invalid checkpoint name" >&2; exit 1;; esac
    [ "\${#2}" -le 64 ] || exit 1
    if [ "$#" -eq 4 ]; then
      [ "$3" = --replace ] || exit 1
      case "$4" in ''|*[!A-Za-z0-9._-]*|.*|-*) echo "Invalid checkpoint name" >&2; exit 1;; esac
      [ "\${#4}" -le 64 ] || exit 1
      exec /usr/bin/node ${current}/dist/src/main.js restore ${config} "${checkpoints}/$2" --replace "${checkpoints}/$4"
    fi
    exec /usr/bin/node ${current}/dist/src/main.js restore ${config} "${checkpoints}/$2" ;;
  *) echo "Usage: matectl status|logs|doctor|offline-probe|upgrade SPEC|rollback|finalize|backup NAME|restore NAME [--replace CURRENT]" >&2; exit 1;;
esac
`;
}
function checked(host: HostOperations, binary: string, args: string[], label: string): string {
  const result = host.run(binary, args);
  if (result.code !== 0)
    throw new Error(`${label}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  return result.stdout.trim();
}
async function account(host: HostOperations, agent: AgentIdentity): Promise<void> {
  if (!agent.username)
    throw new Error(`Managed Linux deployment requires a preconfigured username: ${agent.agentId}`);
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
  host: HostOperations,
  rules: ReturnType<typeof hostRules>,
  plan: LinuxDeploymentPlan,
): Promise<{ release: string; releaseId: string }> {
  const stage = join(managedLayout.releases, `.linux-stage-${randomUUID()}`);
  await host.mkdir(stage, 0o755);
  try {
    for (const name of ["dist", "node_modules", "package.json", "pnpm-lock.yaml"])
      checked(
        host,
        "/usr/bin/cp",
        [
          "-a",
          "--no-preserve=xattr,context",
          join(await host.canonical(plan.release.source), name),
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
    const manifest = await createReleaseManifest(host, stage, plan.release.gitCommit);
    await ensureManagedFile(
      host,
      releaseEntry(join(stage, "RELEASE.json"), 0o444),
      `${JSON.stringify(manifest, null, 2)}\n`,
      rules,
    );
    const release = join(managedLayout.releases, manifest.releaseId);
    if (await pathExists(host, release)) await verifyRelease(host, release, manifest.releaseId);
    else await host.rename(stage, release);
    return { release, releaseId: manifest.releaseId };
  } finally {
    if (await pathExists(host, stage)) await host.remove(stage, { recursive: true });
  }
}
function releaseEntry(path: string, mode: number): ManagedEntry {
  return {
    name: `release-${path.split("/").pop()}`,
    path,
    type: "file",
    owner: "maintenance",
    mode,
  };
}
async function assertSupportedHost(host: HostOperations): Promise<void> {
  const os = Object.fromEntries(
    (await host.readText("/etc/os-release"))
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
}
export async function preflightLinuxDeployment(
  host: HostOperations,
  spec: DeploymentSpec,
  config: DaemonConfig,
): Promise<LinuxDeploymentPlan> {
  const plan = await createLinuxDeploymentPlan(spec, config, host);
  await assertSupportedHost(host);
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
    await host.assertRootExecutable(binary);
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
  const rules = hostRules(config);
  for (const agent of rules.agents) await account(host, agent.identity);
  if ((await host.availableBytes("/")) < plan.requiredBytes)
    throw new Error(`Insufficient free disk space: ${plan.requiredBytes} bytes required`);
  if ((await host.memoryMiB()) < plan.daemonMemoryMiB + 256)
    throw new Error("Host memory is below the daemon plus one Agent process quota");
  if (host.run("/usr/bin/systemctl", ["is-active", "--quiet", "mate.service"]).code === 0)
    throw new Error("Stop mate.service before installation");
  return plan;
}

export async function installLinuxDeployment(
  host: HostOperations,
  spec: DeploymentSpec,
  config: DaemonConfig,
): Promise<{
  plan: LinuxDeploymentPlan;
  releaseId: string;
  serviceStarted: false;
}> {
  if (host.euid() !== 0) throw new Error("Linux deployment installation must run as root");
  const plan = await preflightLinuxDeployment(host, spec, config),
    rules = hostRules(config),
    control = rules.control;
  await ensureManagedDirectory(host, control.optDir, rules);
  await ensureManagedDirectory(host, control.releases, rules);
  await ensureManagedDirectory(host, control.configDir, rules);
  await ensureManagedDirectory(host, control.data, rules);
  await ensureManagedDirectory(host, control.state, rules);
  await ensureManagedDirectory(host, control.controlDir, rules);
  await ensureManagedDirectory(host, control.backupsParent, rules);
  await ensureManagedDirectory(host, control.checkpoints, rules);
  await ensureManagedDirectory(host, control.sharedRootParent, rules);
  await ensureManagedDirectory(host, control.sharedRoot, rules);
  for (const agent of rules.agents) {
    const definition = config.mate.agents.find((item) => item.id === agent.identity.agentId)!;
    await ensureAgentWorkspace(host, rules, agent, initialMemory(definition.name));
  }
  const { release, releaseId } = await publishLinuxRelease(host, rules, plan);
  const configText = `${JSON.stringify(config, null, 2)}\n`,
    envText = plan.environmentSource ? await host.readText(plan.environmentSource) : "";
  await ensureManagedFile(host, control.configFile, configText, rules);
  await ensureManagedFile(host, control.environmentFile, envText, rules);
  for (const entry of control.parentSlices)
    await ensureManagedFile(host, entry, renderParentSlice(), rules);
  for (const agent of rules.agents)
    await ensureManagedFile(host, agent.slice, renderAgentSlice(), rules);
  await ensureManagedFile(host, control.serviceFile, renderLinuxService(plan), rules);
  await ensureManagedFile(host, control.wrapper, renderLinuxMaintenanceWrapper(), rules);
  for (const link of [managedLayout.current, managedLayout.controller]) {
    if (await pathExists(host, link)) {
      if ((await host.canonical(link)) !== release)
        throw new Error(`Existing release link differs: ${link}`);
    } else checked(host, "/usr/bin/ln", ["-s", release, link], `Cannot publish ${link}`);
  }
  checked(host, "/usr/bin/systemctl", ["daemon-reload"], "Cannot reload systemd");
  for (const unit of parentSliceUnits)
    checked(host, "/usr/bin/systemctl", ["start", unit], `Cannot start ${unit}`);
  for (const agent of rules.agents)
    checked(
      host,
      "/usr/bin/systemctl",
      ["start", agent.sliceUnit],
      `Cannot start ${agent.sliceUnit}`,
    );
  checked(
    host,
    "/usr/bin/systemctl",
    ["disable", "--now", "mate.service"],
    "Cannot leave Mate stopped for credential setup",
  );
  return { plan, releaseId, serviceStarted: false };
}

export async function disableLinuxDeployment(
  host: HostOperations,
  config: DaemonConfig,
): Promise<void> {
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

export const linuxUpgradeJournalPath = (dataDir: string = managedLayout.data): string =>
  join(dataDir, "control", "linux-upgrade.json");
const upgradeJournalEntry = (path: string): ManagedEntry => ({
  name: "linux-upgrade-journal",
  path,
  type: "file",
  owner: "maintenance",
  mode: 0o600,
});
async function inactiveAndIdle(
  host: HostOperations,
  config: DaemonConfig,
  rules = hostRules(config),
): Promise<void> {
  const service = host.run("/usr/bin/systemctl", [
    "show",
    "mate.service",
    "-p",
    "ActiveState",
    "--value",
  ]);
  if (service.code !== 0 || !["inactive", "failed"].includes(service.stdout.trim()))
    throw new Error("Stop mate.service before upgrade");
  const manager = hostProcessManager(host, rules);
  for (const agent of rules.agents)
    if ((await manager.list(agent.identity.agentId)).length)
      throw new Error(`Stop ${agent.identity.agentId} background tasks before upgrade`);
}
export async function readLinuxUpgradeJournal(
  host: HostOperations,
  path = linuxUpgradeJournalPath(),
): Promise<{
  oldRelease: string;
  newRelease: string;
}> {
  await assertManagedEntry(host, upgradeJournalEntry(path));
  const value = JSON.parse(await host.readText(path)) as {
    oldRelease?: string;
    newRelease?: string;
  };
  for (const release of [value.oldRelease, value.newRelease])
    if (
      !release ||
      !release.startsWith(`${managedLayout.releases}/`) ||
      (await host.canonical(release)) !== release
    )
      throw new Error("Linux upgrade release identity is invalid");
  return value as { oldRelease: string; newRelease: string };
}
async function installedConfig(host: HostOperations): Promise<DaemonConfig> {
  return daemonConfigSchema.parse(JSON.parse(await host.readText(managedLayout.config)));
}
async function switchReleaseLink(
  host: HostOperations,
  link: string,
  target: string,
): Promise<void> {
  const temporary = join(dirname(managedLayout.current), `.release-link-${randomUUID()}`);
  await host.symlink(target, temporary);
  await host.rename(temporary, link);
}
export async function upgradeLinuxDeployment(
  host: HostOperations,
  spec: DeploymentSpec,
  config: DaemonConfig,
): Promise<{ oldRelease: string; newRelease: string; serviceStarted: false }> {
  if (host.euid() !== 0) throw new Error("Linux upgrade requires root");
  const plan = await preflightLinuxDeployment(host, spec, config),
    rules = hostRules(config),
    journalPath = linuxUpgradeJournalPath();
  await inactiveAndIdle(host, config, rules);
  if (await pathExists(host, journalPath))
    throw new Error("Finish or roll back the previous upgrade first");
  const installed = await installedConfig(host);
  if (!sameConfiguration(installed, config))
    throw new Error(
      "Upgrade uses the installed configuration: stop Mate, write the new configuration to the managed configuration file, start it once so Mate applies the change, then upgrade",
    );
  if (
    plan.environmentSource &&
    (await host.readText(plan.environmentSource)) !==
      (await host.readText(managedLayout.environment))
  )
    throw new Error("Code upgrade cannot silently change credentials");
  const oldRelease = await host.canonical(managedLayout.current);
  await verifyRelease(host, oldRelease);
  const { release: newRelease } = await publishLinuxRelease(host, rules, plan);
  if (newRelease === oldRelease) throw new Error("Candidate is already the current release");
  const doctor = await runDoctor(host, config, {
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
  await ensureManagedFile(
    host,
    upgradeJournalEntry(journalPath),
    `${JSON.stringify({ oldRelease, newRelease })}\n`,
    rules,
  );
  await switchReleaseLink(host, managedLayout.current, newRelease);
  return { oldRelease, newRelease, serviceStarted: false };
}
export async function finishLinuxUpgrade(
  host: HostOperations,
  command: "rollback" | "finalize",
): Promise<void> {
  if (host.euid() !== 0) throw new Error("Linux upgrade maintenance requires root");
  const config = await installedConfig(host);
  if (!config.runtime.linuxUsers) throw new Error("Linux identities are not configured");
  const rules = hostRules(config);
  await inactiveAndIdle(host, config, rules);
  const journal = await readLinuxUpgradeJournal(host);
  await verifyRelease(host, journal.oldRelease);
  await verifyRelease(host, journal.newRelease);
  const current = await host.canonical(managedLayout.current);
  if (current !== journal.newRelease && current !== journal.oldRelease)
    throw new Error("Current release differs from the upgrade journal");
  // The controller remains pinned to the initially installed release, independent of candidate code.
  await verifyRelease(host, await host.canonical(managedLayout.controller));
  if (command === "rollback")
    await switchReleaseLink(host, managedLayout.current, journal.oldRelease);
  else if (current !== journal.newRelease) throw new Error("Cannot finalize a rolled-back upgrade");
  await host.unlink(linuxUpgradeJournalPath());
}
