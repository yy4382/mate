import { dirname, join, resolve } from "node:path";
import type { DaemonConfig } from "../daemon/config.js";
import {
  LinuxProcessManager,
  ProcessWaitInterruptedError,
  agentSliceUnit,
} from "../execution/linux-processes.js";
import { pathExists, type HostOperations, type HostStat } from "./host.js";
import { managedLayout } from "./systemd.js";

/** Process quota facts shared by the installer, doctor, offline probe and process control. */
export const agentQuota = Object.freeze({
  memoryMiB: 256 as const,
  tasksMax: 128 as const,
  cpuQuota: "100%" as const,
});
/** The slice-unit fact is defined with process control and re-exported here for deployment rules. */
export { agentSliceUnit };
export const parentSliceUnits = Object.freeze(["mate.slice", "mate-agent.slice"]);
export const sliceUnitPath = (unit: string): string => join("/etc/systemd/system", unit);

export interface AgentIdentity {
  agentId: string;
  uid: number;
  gid: number;
  /** Required by the flows that inspect the passwd database; restore only needs uid, gid and home. */
  username?: string;
  home: string;
}
/**
 * One managed path with the single rule set applied to it by install, upgrade, doctor,
 * offline probe and restore.
 *
 * `maintenance` means the account running the maintenance command (root on a real Debian
 * deployment, where every maintenance entry point refuses to run as anyone else);
 * `agent` means the configured Agent Linux identity. Modes are absolute permission bits.
 */
export interface ManagedEntry {
  name: string;
  path: string;
  type: "directory" | "file";
  owner: "maintenance" | "agent";
  mode: number;
  agentId?: string;
}
export interface AgentEntries {
  identity: AgentIdentity;
  sliceUnit: string;
  homeParent: ManagedEntry;
  home: ManagedEntry;
  memory: ManagedEntry;
  notes: ManagedEntry;
  artifacts: ManagedEntry;
  shared: ManagedEntry;
  slice: ManagedEntry;
}
export interface HostRules {
  /** Every maintenance-owned path an installation creates and a check re-verifies. */
  control: {
    optDir: ManagedEntry;
    releases: ManagedEntry;
    configDir: ManagedEntry;
    data: ManagedEntry;
    state: ManagedEntry;
    controlDir: ManagedEntry;
    backupsParent: ManagedEntry;
    checkpoints: ManagedEntry;
    sharedRootParent: ManagedEntry;
    sharedRoot: ManagedEntry;
    configFile: ManagedEntry;
    environmentFile: ManagedEntry;
    serviceFile: ManagedEntry;
    wrapper: ManagedEntry;
    parentSlices: ManagedEntry[];
  };
  /** The subset a managed restore requires before it replaces live state. */
  restoreBoundary: ManagedEntry[];
  agents: AgentEntries[];
}

/** The single rule set for paths, ownership, permissions and unit ownership. */
export function hostRules(config: DaemonConfig): HostRules {
  const data = resolve(config.runtime.dataDir);
  if (!config.runtime.sharedRoot)
    throw new Error("Linux deployment requires a shared root for Agent workspaces");
  const sharedRoot = resolve(config.runtime.sharedRoot);
  const control: HostRules["control"] = {
    optDir: directory("opt", "/opt/mate", 0o755),
    releases: directory("releases", managedLayout.releases, 0o755),
    configDir: directory("config-dir", managedLayout.configDir, 0o700),
    data: directory("data", data, 0o700),
    state: directory("state", join(data, "state"), 0o700),
    controlDir: directory("control", join(data, "control"), 0o700),
    backupsParent: directory("backups", dirname(managedLayout.checkpoints), 0o755),
    checkpoints: directory("checkpoints", managedLayout.checkpoints, 0o700),
    sharedRootParent: directory("shared-root-parent", dirname(sharedRoot), 0o755),
    sharedRoot: directory("shared-root", sharedRoot, 0o755),
    configFile: file("config", managedLayout.config, 0o600),
    environmentFile: file("environment", managedLayout.environment, 0o600),
    serviceFile: file("service", managedLayout.service, 0o644),
    wrapper: file("wrapper", managedLayout.wrapper, 0o755),
    parentSlices: parentSliceUnits.map((unit) => file(`slice-${unit}`, sliceUnitPath(unit), 0o644)),
  };
  const agents = Object.entries(config.runtime.linuxUsers ?? {})
    .map(([agentId, user]) => {
      const home = resolve(user.home),
        sliceUnit = agentSliceUnit(user.uid);
      return {
        identity: {
          agentId,
          uid: user.uid,
          gid: user.gid,
          ...(user.username ? { username: user.username } : {}),
          home,
        },
        sliceUnit,
        // The parent of a private home belongs to the maintenance account, not to the Agent.
        homeParent: directory("agent-home-parent", dirname(home), 0o755),
        home: directory("agent-home", home, 0o700, agentId),
        memory: file("agent-memory", join(home, "MEMORY.md"), 0o600, agentId),
        notes: directory("agent-notes", join(home, "notes"), 0o700, agentId),
        artifacts: directory("agent-artifacts", join(home, "artifacts"), 0o700, agentId),
        shared: directory("agent-shared", join(sharedRoot, agentId), 0o755, agentId),
        slice: file(`slice-${sliceUnit}`, sliceUnitPath(sliceUnit), 0o644, agentId),
      };
    })
    .sort((left, right) => left.identity.agentId.localeCompare(right.identity.agentId));
  if (agents.length !== config.mate.agents.length)
    throw new Error("Every Agent needs one Linux identity");
  return {
    control,
    restoreBoundary: [control.data, control.state, control.controlDir],
    agents,
  };
}

function managed(
  name: string,
  path: string,
  type: ManagedEntry["type"],
  mode: number,
  agentId?: string,
): ManagedEntry {
  return agentId
    ? { name, path, type, owner: "agent", mode, agentId }
    : { name, path, type, owner: "maintenance", mode };
}
function directory(name: string, path: string, mode: number, agentId?: string): ManagedEntry {
  return managed(name, path, "directory", mode, agentId);
}
function file(name: string, path: string, mode: number, agentId?: string): ManagedEntry {
  return managed(name, path, "file", mode, agentId);
}

/** Every maintenance-owned entry, in installation order. */
export function controlEntries(rules: HostRules): ManagedEntry[] {
  const { parentSlices, ...rest } = rules.control;
  return [...Object.values(rest), ...parentSlices];
}
/** The process-control view of the same UID and slice facts, routed through the host entry. */
export function hostProcessManager(host: HostOperations, rules: HostRules): LinuxProcessManager {
  return new LinuxProcessManager(
    Object.fromEntries(rules.agents.map((agent) => [agent.identity.agentId, agent.identity.uid])),
    // Every systemctl wait is awaited, never blocked on. Maintenance runs as one-shot bounded host
    // commands, so its wait is bounded by the host entry's own timeout; the daemon's process
    // control uses the spawn-based runner that a run signal can cancel.
    async (args, wait) => {
      if (wait?.signal?.aborted)
        throw new ProcessWaitInterruptedError(`systemctl ${args[0]} cancelled`);
      return host.run(
        "/usr/bin/systemctl",
        args,
        wait?.timeoutMs ? { timeoutMs: wait.timeoutMs } : undefined,
      );
    },
    (group) => host.processes.pids(group),
    (pid) => host.processes.uid(pid),
  );
}

function agentFor(rules: HostRules | undefined, agentId: string | undefined): AgentEntries {
  const agent = rules?.agents.find((item) => item.identity.agentId === agentId);
  if (!agent) throw new Error("Managed entry refers to an unknown Agent identity");
  return agent;
}
function expectedOwner(
  host: HostOperations,
  entry: ManagedEntry,
  rules: HostRules | undefined,
): { uid: number; gid: number } {
  if (entry.owner === "maintenance") return { uid: host.euid(), gid: host.egid() };
  const { uid, gid } = agentFor(rules, entry.agentId).identity;
  return { uid, gid };
}
const octal = (mode: number): string => `0${mode.toString(8).padStart(3, "0")}`;

function assertEntryStat(
  entry: ManagedEntry,
  stat: HostStat,
  owner: { uid: number; gid: number },
): void {
  const kind = entry.type === "directory" ? stat.isDirectory() : stat.isFile();
  if (!kind || stat.isSymbolicLink())
    throw new Error(`${entry.name} is not a ${entry.type}: ${entry.path}`);
  if (stat.uid !== owner.uid || stat.gid !== owner.gid)
    throw new Error(`${entry.name} must be owned by ${owner.uid}:${owner.gid}: ${entry.path}`);
  if ((stat.mode & 0o777) !== entry.mode)
    throw new Error(`${entry.name} must have mode ${octal(entry.mode)}: ${entry.path}`);
  if (entry.type === "file" && stat.nlink !== 1)
    throw new Error(`${entry.name} must be one regular file without hard links: ${entry.path}`);
}

/** Re-verify one managed path against its rule. Used by install, doctor, probe and restore. */
export async function assertManagedEntry(
  host: HostOperations,
  entry: ManagedEntry,
  rules?: HostRules,
): Promise<void> {
  const stat = await host.lstat(entry.path);
  assertEntryStat(entry, stat, expectedOwner(host, entry, rules));
  if ((await host.canonical(entry.path)) !== resolve(entry.path))
    throw new Error(`${entry.name} must be a canonical path, not a link: ${entry.path}`);
}

/** Create one managed directory if it is absent, then re-verify it against its rule. */
export async function ensureManagedDirectory(
  host: HostOperations,
  entry: ManagedEntry,
  rules?: HostRules,
): Promise<void> {
  if (!(await pathExists(host, entry.path))) {
    const owner = expectedOwner(host, entry, rules);
    await host.mkdir(entry.path, entry.mode);
    await host.chown(entry.path, owner.uid, owner.gid);
    await host.chmod(entry.path, entry.mode);
  }
  await assertManagedEntry(host, entry, rules);
}

/**
 * Create one managed file with its rule's owner and mode if it is absent, then re-verify it.
 * An existing file is never overwritten: differing contents are reported, not silently replaced.
 */
export async function ensureManagedFile(
  host: HostOperations,
  entry: ManagedEntry,
  text: string,
  rules?: HostRules,
): Promise<void> {
  if (!(await pathExists(host, entry.path))) {
    const owner = expectedOwner(host, entry, rules);
    const handle = await host.createExclusive(entry.path, entry.mode);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await host.chown(entry.path, owner.uid, owner.gid);
    await host.chmod(entry.path, entry.mode);
    // The directory entry must be durable too: a maintenance decision is only "on disk"
    // once the name survives a crash, exactly like the checkpoint and restore journals.
    await host.fsyncDirectory(dirname(entry.path));
  }
  await assertManagedEntry(host, entry, rules);
  if ((await host.readText(entry.path)) !== text)
    throw new Error(`${entry.name} differs from the managed contents: ${entry.path}`);
}

/** The private workspace a managed deployment guarantees for one Agent. */
export async function ensureAgentWorkspace(
  host: HostOperations,
  rules: HostRules,
  agent: AgentEntries,
  memoryText: string,
): Promise<void> {
  await ensureManagedDirectory(host, agent.homeParent, rules);
  await ensureManagedDirectory(host, agent.home, rules);
  if (await pathExists(host, agent.memory.path)) {
    // An existing private workspace belongs to its Agent: verify the identity, never rewrite contents.
    await assertManagedEntry(host, agent.memory, rules);
  } else {
    await ensureManagedDirectory(host, agent.notes, rules);
    await ensureManagedDirectory(host, agent.artifacts, rules);
    await ensureManagedFile(host, agent.memory, memoryText, rules);
  }
  await ensureManagedDirectory(host, agent.shared, rules);
}
/** Re-verify the Agent facts every managed flow depends on before it touches private data. */
export async function assertAgentWorkspace(
  host: HostOperations,
  rules: HostRules,
  agent: AgentEntries,
): Promise<void> {
  await assertManagedEntry(host, agent.home, rules);
  await assertManagedEntry(host, agent.memory, rules);
  await assertManagedEntry(host, agent.shared, rules);
}

/** Permission summary published in the deployment plan, derived from the same rules. */
export function describePermissions(rules: HostRules): {
  mateData: string;
  configAndSecrets: string;
  privateHomes: string;
  sharedRoot: string;
  sharedAgentDirectories: string;
} {
  const agent = rules.agents[0];
  return {
    mateData: `root:root ${octal(rules.control.data.mode)}`,
    configAndSecrets: `root:root ${octal(rules.control.configFile.mode)}`,
    privateHomes: `Agent UID:GID ${octal(agent?.home.mode ?? 0o700)}`,
    sharedRoot: `root:root ${octal(rules.control.sharedRoot.mode)}`,
    sharedAgentDirectories: `Agent UID:GID ${octal(agent?.shared.mode ?? 0o755)}`,
  };
}
