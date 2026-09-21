import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import type { DaemonConfig } from '../daemon/config.js';
import { deploymentSpecSchema, type DeploymentSpec } from './spec.js';
import { managedLayout } from './systemd.js';

const MiB = 1024 * 1024;
export interface PlannedWorkspace { kind: 'private' | 'external'; agentId?: string; root: string; backingFile: string; capacityBytes: number }
export interface DeploymentPlan {
  version: 1;
  target: { os: 'debian'; version: '13'; arch: 'x64'; nodeMajor: 24; serviceUser: 'mate'; dockerGroup: 'docker' };
  layout: typeof managedLayout;
  release: { source: string; gitCommit: string; retainedCopies: 2; candidateBytes: number; reservedBytes: number };
  dockerImage: { reference: string; installedBytes: number | null; includedInRequiredBytes: false };
  workspaces: PlannedWorkspace[];
  storage: { backingBytes: number; stateReserveBytes: number; releaseReserveBytes: number; totalRequiredBytes: number };
  memory: { daemonMiB: number; maxConcurrentContainers: number; perContainerMiB: number; upperBoundMiB: number };
  environmentConfigured: boolean;
}
export interface PlanFacts { directoryBytes(path: string): number; canonical(path: string): string; dockerImageBytes?(reference: string): number | undefined }

function contains(parent: string, child: string): boolean { return child === parent || child.startsWith(`${parent}${sep}`); }
function overlap(left: string, right: string): boolean { return contains(left, right) || contains(right, left); }
function slug(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 16); }

export function createDeploymentPlan(rawSpec: DeploymentSpec, config: DaemonConfig, facts: PlanFacts): DeploymentPlan {
  const spec = deploymentSpecSchema.parse(rawSpec);
  if (config.runtime.dataDir !== managedLayout.data || config.runtime.workspaceManifest !== managedLayout.manifest || !config.runtime.docker) throw new Error('Managed deployment config must use the fixed data, manifest and Docker layout');
  if (config.runtime.docker.binary !== '/usr/bin/docker' || config.runtime.docker.host !== 'unix:///var/run/docker.sock') throw new Error('Managed deployment requires the fixed Debian Docker control paths');
  const source = facts.canonical(spec.release.source), configSource = facts.canonical(spec.configSource);
  if (source !== spec.release.source || configSource !== spec.configSource) throw new Error('Deployment sources must be canonical paths');
  const agents = [...config.mate.agents.map(agent => agent.id)].sort(), agentSet = new Set(agents), privateByAgent = new Map<string, number>();
  for (const item of spec.privateWorkspaces) { if (!agentSet.has(item.agentId)) throw new Error('Private workspace override names an unknown Agent'); if (privateByAgent.has(item.agentId)) throw new Error('Duplicate private workspace spec'); privateByAgent.set(item.agentId, item.capacityMiB); }
  const grants = [...new Set(config.runtime.workspaceGrants.map(grant => facts.canonical(grant.root)))].sort();
  if ([source, configSource, ...grants].some(path => !/^\/[A-Za-z0-9_./-]+$/.test(path))) throw new Error('Managed deployment paths must use systemd-safe absolute characters');
  const externalByRoot = new Map<string, number>();
  for (const item of spec.externalWorkspaces) { const root = facts.canonical(item.root); if (root !== item.root || externalByRoot.has(root)) throw new Error('External workspace specs must be unique canonical paths'); externalByRoot.set(root, item.capacityMiB); }
  if (JSON.stringify([...externalByRoot.keys()].sort()) !== JSON.stringify(grants)) throw new Error('External workspace spec must exactly cover configured grants');
  const roots = [...agents.map(agentId => join(managedLayout.data, 'agents', agentId)), ...grants];
  for (let left = 0; left < roots.length; left++) for (let right = left + 1; right < roots.length; right++) if (overlap(roots[left]!, roots[right]!)) throw new Error('Managed workspace roots must not overlap');
  for (const root of grants) if (contains(managedLayout.data, root) || contains(managedLayout.volumes, root) || contains(managedLayout.configDir, root) || contains(managedLayout.releases, root) || contains(managedLayout.checkpoints, root)) throw new Error('External workspace overlaps Mate control or private data');
  const workspaces: PlannedWorkspace[] = [
    ...agents.map(agentId => ({ kind: 'private' as const, agentId, root: join(managedLayout.data, 'agents', agentId), backingFile: join(managedLayout.volumes, `private-${agentId}.ext4`), capacityBytes: (privateByAgent.get(agentId) ?? 512) * MiB })),
    ...grants.map(root => ({ kind: 'external' as const, root, backingFile: join(managedLayout.volumes, `external-${slug(root)}.ext4`), capacityBytes: externalByRoot.get(root)! * MiB })),
  ];
  const candidateBytes = facts.directoryBytes(source), releaseReserveBytes = candidateBytes * 2, backingBytes = workspaces.reduce((sum, item) => sum + item.capacityBytes, 0), stateReserveBytes = spec.stateReserveMiB * MiB;
  const maxConcurrentContainers = config.runtime.limits.maxBackendOperations, perContainerMiB = config.runtime.docker.resources.memoryMb;
  return {
    version: 1, target: { os: 'debian', version: '13', arch: 'x64', nodeMajor: 24, serviceUser: 'mate', dockerGroup: 'docker' }, layout: managedLayout,
    release: { source, gitCommit: spec.release.gitCommit, retainedCopies: 2, candidateBytes, reservedBytes: releaseReserveBytes },
    dockerImage: { reference: config.runtime.docker.image, installedBytes: facts.dockerImageBytes?.(config.runtime.docker.image) ?? null, includedInRequiredBytes: false }, workspaces,
    storage: { backingBytes, stateReserveBytes, releaseReserveBytes, totalRequiredBytes: backingBytes + stateReserveBytes + releaseReserveBytes },
    memory: { daemonMiB: spec.daemonMemoryMiB, maxConcurrentContainers, perContainerMiB, upperBoundMiB: spec.daemonMemoryMiB + maxConcurrentContainers * perContainerMiB },
    environmentConfigured: !!spec.environmentSource,
  };
}
