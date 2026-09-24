import { resolve, sep } from "node:path";
import type { DaemonConfig } from "../daemon/config.js";
import { deploymentSpecSchema, type DeploymentSpec } from "./spec.js";
import { managedLayout } from "./systemd.js";
import { agentQuota, describePermissions, hostRules } from "./host-rules.js";
import type { HostOperations } from "./host.js";

export interface LinuxDeploymentPlan {
  version: 1;
  mode: "linux-users";
  target: { os: "debian"; version: "13"; arch: "x64"; nodeMajor: 24 };
  release: { source: string; gitCommit: string; candidateBytes: number };
  configSource: string;
  environmentSource: string | null;
  dataDir: string;
  sharedRoot: string;
  permissions: ReturnType<typeof describePermissions>;
  agents: Array<{
    agentId: string;
    uid: number;
    gid: number;
    username: string;
    home: string;
    slice: string;
    memoryMiB: 256;
    tasksMax: 128;
    cpuQuota: "100%";
  }>;
  daemonMemoryMiB: number;
  requiredBytes: number;
}

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

export async function createLinuxDeploymentPlan(
  rawSpec: DeploymentSpec,
  config: DaemonConfig,
  host: HostOperations,
): Promise<LinuxDeploymentPlan> {
  const spec = deploymentSpecSchema.parse(rawSpec);
  if (!config.runtime.linuxUsers || !config.runtime.sharedRoot)
    throw new Error("Linux deployment requires Agent Linux users and a shared root");
  if (config.runtime.dataDir !== managedLayout.data)
    throw new Error("Managed Linux deployment requires /var/lib/mate");
  const rules = hostRules(config);
  const source = await host.canonical(spec.release.source),
    configSource = await host.canonical(spec.configSource),
    environmentSource = spec.environmentSource
      ? await host.canonical(spec.environmentSource)
      : null;
  if (
    source !== spec.release.source ||
    configSource !== spec.configSource ||
    environmentSource !== (spec.environmentSource ?? null)
  )
    throw new Error("Deployment inputs must have canonical paths");
  const sharedRoot = await host.canonical(config.runtime.sharedRoot);
  if (sharedRoot !== config.runtime.sharedRoot) throw new Error("Shared root must be canonical");
  const protectedRoots = [
    managedLayout.data,
    managedLayout.configDir,
    managedLayout.releases,
    managedLayout.checkpoints,
  ];
  const homes: LinuxDeploymentPlan["agents"] = [];
  for (const agent of rules.agents) {
    const home = await host.canonical(agent.identity.home);
    if (home !== agent.identity.home || resolve(home) !== home)
      throw new Error(`Agent home must be canonical: ${agent.identity.agentId}`);
    if (!agent.identity.username)
      throw new Error(
        `Managed Linux deployment requires a preconfigured username: ${agent.identity.agentId}`,
      );
    homes.push({
      agentId: agent.identity.agentId,
      uid: agent.identity.uid,
      gid: agent.identity.gid,
      username: agent.identity.username,
      home,
      slice: agent.sliceUnit,
      ...agentQuota,
    });
  }
  const roots = [sharedRoot, ...homes.map((item) => item.home)];
  for (const root of roots)
    if (
      protectedRoots.some(
        (protectedRoot) => within(root, protectedRoot) || within(protectedRoot, root),
      )
    )
      throw new Error(`Agent workspace overlaps Mate control or system paths: ${root}`);
  for (let a = 0; a < roots.length; a++)
    for (let b = a + 1; b < roots.length; b++)
      if (within(roots[a]!, roots[b]!) || within(roots[b]!, roots[a]!))
        throw new Error("Agent private homes and shared root must not overlap");
  const candidateBytes = await host.directoryBytes(source);
  return {
    version: 1,
    mode: "linux-users",
    target: { os: "debian", version: "13", arch: "x64", nodeMajor: 24 },
    release: { source, gitCommit: spec.release.gitCommit, candidateBytes },
    configSource,
    environmentSource,
    dataDir: managedLayout.data,
    sharedRoot,
    permissions: describePermissions(rules),
    agents: homes,
    daemonMemoryMiB: spec.daemonMemoryMiB,
    requiredBytes: candidateBytes * 2 + spec.stateReserveMiB * 1024 * 1024,
  };
}
