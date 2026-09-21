import { join, resolve } from 'node:path';
import type { DaemonConfig } from '../daemon/config.js';
import { acquireLock } from '../daemon/lock.js';
import { assertDockerControlIsolation, executionScope } from '../daemon/paths.js';
import { ContainerBackend } from '../execution/container.js';
import { verifyDeploymentWorkspaces } from './runtime.js';

/** Stateful deployment probe. The service wrapper must first prove mate.service is stopped. */
export async function runOfflineProbe(config: DaemonConfig, projectRoot = resolve('.')): Promise<{ roots: string[] }> {
  if (!config.runtime.docker || !config.runtime.workspaceManifest) throw new Error('Offline probe requires managed Docker and workspace configuration');
  const state = join(config.runtime.dataDir, 'state'), agents = join(config.runtime.dataDir, 'agents');
  const release = acquireLock(join(state, 'daemon.lock'));
  try {
    assertDockerControlIsolation(projectRoot, state, agents, config.runtime.workspaceGrants, config.runtime.docker, [config.runtime.workspaceManifest]);
    const workspaces = verifyDeploymentWorkspaces(config);
    if (!workspaces) throw new Error('Managed workspace verification is unavailable');
    const backend = new ContainerBackend({ ...config.runtime.docker, scope: executionScope(config.runtime.dataDir) });
    await backend.recover();
    const roots = [...workspaces.roots.values(), ...workspaces.externalRoots];
    for (const root of roots) await backend.probe(root);
    return { roots };
  } finally { release(); }
}
