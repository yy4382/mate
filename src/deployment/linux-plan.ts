import { resolve, sep } from 'node:path';
import type { DaemonConfig } from '../daemon/config.js';
import { deploymentSpecSchema, type DeploymentSpec } from './spec.js';
import { managedLayout } from './systemd.js';

export interface LinuxDeploymentPlan {
  version: 1;
  mode: 'linux-users';
  target: { os: 'debian'; version: '13'; arch: 'x64'; nodeMajor: 24 };
  release: { source: string; gitCommit: string; candidateBytes: number };
  configSource: string;
  environmentSource: string | null;
  dataDir: string;
  sharedRoot: string;
  permissions: { mateData: 'root:root 0700'; configAndSecrets: 'root:root 0600'; privateHomes: 'Agent UID:GID 0700'; sharedRoot: 'root:root 0755'; sharedAgentDirectories: 'Agent UID:GID 0755' };
  agents: Array<{ agentId: string; uid: number; gid: number; username: string; home: string; slice: string; memoryMiB: 256; tasksMax: 128; cpuQuota: '100%' }>;
  daemonMemoryMiB: number;
  requiredBytes: number;
}

export interface LinuxPlanFacts { canonical(path: string): string; directoryBytes(path: string): number }
function within(parent: string, child: string): boolean { return child === parent || child.startsWith(`${parent}${sep}`); }

export function createLinuxDeploymentPlan(rawSpec: DeploymentSpec, config: DaemonConfig, facts: LinuxPlanFacts): LinuxDeploymentPlan {
  const spec = deploymentSpecSchema.parse(rawSpec), users = config.runtime.linuxUsers;
  if (!users || !config.runtime.sharedRoot) throw new Error('Linux deployment requires Agent Linux users and a shared root');
  if (config.runtime.dataDir !== managedLayout.data) throw new Error('Managed Linux deployment requires /var/lib/mate');
  const source = facts.canonical(spec.release.source), configSource = facts.canonical(spec.configSource), environmentSource = spec.environmentSource ? facts.canonical(spec.environmentSource) : null;
  if (source !== spec.release.source || configSource !== spec.configSource || environmentSource !== (spec.environmentSource ?? null)) throw new Error('Deployment inputs must have canonical paths');
  const sharedRoot = facts.canonical(config.runtime.sharedRoot);
  if (sharedRoot !== config.runtime.sharedRoot) throw new Error('Shared root must be canonical');
  const protectedRoots = [managedLayout.data, managedLayout.configDir, managedLayout.releases, managedLayout.checkpoints];
  const homes = Object.entries(users).map(([agentId, user]) => {
    const home = facts.canonical(user.home);
    if (home !== user.home || resolve(home) !== home) throw new Error(`Agent home must be canonical: ${agentId}`);
    if (!user.username) throw new Error(`Managed Linux deployment requires a preconfigured username: ${agentId}`);
    return { agentId, uid: user.uid, gid: user.gid, username: user.username, home, slice: `mate-agent-${user.uid}.slice`, memoryMiB: 256 as const, tasksMax: 128 as const, cpuQuota: '100%' as const };
  }).sort((a, b) => a.agentId.localeCompare(b.agentId));
  const roots = [sharedRoot, ...homes.map(item => item.home)];
  for (const root of roots) if (protectedRoots.some(protectedRoot => within(root, protectedRoot) || within(protectedRoot, root))) throw new Error(`Agent workspace overlaps Mate control or system paths: ${root}`);
  for (let a = 0; a < roots.length; a++) for (let b = a + 1; b < roots.length; b++) if (within(roots[a]!, roots[b]!) || within(roots[b]!, roots[a]!)) throw new Error('Agent private homes and shared root must not overlap');
  if (homes.length !== config.mate.agents.length) throw new Error('Every Agent needs one Linux identity');
  const candidateBytes = facts.directoryBytes(source);
  return { version: 1, mode: 'linux-users', target: { os: 'debian', version: '13', arch: 'x64', nodeMajor: 24 }, release: { source, gitCommit: spec.release.gitCommit, candidateBytes }, configSource, environmentSource, dataDir: managedLayout.data, sharedRoot,
    permissions: { mateData: 'root:root 0700', configAndSecrets: 'root:root 0600', privateHomes: 'Agent UID:GID 0700', sharedRoot: 'root:root 0755', sharedAgentDirectories: 'Agent UID:GID 0755' },
    agents: homes, daemonMemoryMiB: spec.daemonMemoryMiB, requiredBytes: candidateBytes * 2 + spec.stateReserveMiB * 1024 * 1024 };
}
