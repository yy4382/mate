import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DaemonConfig } from '../daemon/config.js';
import { dockerSocketPath } from '../daemon/paths.js';
import { verifyDeploymentWorkspaces } from './runtime.js';
import { managedLayout } from './systemd.js';
import { verifyRelease } from './release.js';

export type DoctorStatus = 'pass' | 'fail' | 'info';
export interface DoctorCheck { name: string; status: DoctorStatus; detail: string }
export interface DoctorReport { version: 1; healthy: boolean; checks: DoctorCheck[] }
export interface DoctorEnvironment {
  platform: NodeJS.Platform;
  arch: string;
  node: string;
  modulesAbi: string;
  uid: number;
  gid: number;
  read(path: string): string;
  run(binary: string, args: readonly string[]): { code: number; stdout: string; stderr: string };
}

const nodeEnvironment = (): DoctorEnvironment => ({
  platform: process.platform, arch: process.arch, node: process.version, modulesAbi: process.versions.modules,
  uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1, read: path => readFileSync(path, 'utf8'),
  run: (binary, args) => { const result = spawnSync(binary, [...args], { encoding: 'utf8', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } }); return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? String(result.error ?? '') }; },
});

function protectedFile(path: string, gid: number, mode: number): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== 0 || stat.gid !== gid || (stat.mode & 0o777) !== mode) throw new Error(`${path} must be root-owned and mode ${mode.toString(8)}`);
}

function requiredSecretReferences(config: DaemonConfig): string[] {
  return [...new Set([
    ...config.mate.agents.map(agent => agent.model.apiKeyEnv),
    ...(config.adapters.slack?.bindings.flatMap(binding => [binding.botTokenEnv, binding.appTokenEnv]) ?? []),
  ])].sort();
}

export interface DoctorOptions { releaseRoot?: string; requireSecrets?: boolean }

export async function runDoctor(config: DaemonConfig, env: DoctorEnvironment = nodeEnvironment(), options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const check = async (name: string, action: () => string | Promise<string>, failure = true): Promise<void> => {
    try { checks.push({ name, status: failure ? 'pass' : 'info', detail: await action() }); }
    catch (error) { checks.push({ name, status: failure ? 'fail' : 'info', detail: error instanceof Error ? error.message : String(error) }); }
  };
  await check('supported-runtime', () => {
    if (env.platform !== 'linux' || env.arch !== 'x64' || !/^v24\./.test(env.node)) throw new Error('Expected Debian deployment runtime: Linux x86_64 and Node 24');
    const values = Object.fromEntries(env.read('/etc/os-release').split('\n').filter(line => line.includes('=')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, '')]; }));
    if (values.ID !== 'debian' || values.VERSION_ID !== '13') throw new Error('Only Debian 13 x86_64 is an accepted production baseline');
    return `Debian 13 ${env.arch}, ${env.node}, ABI ${env.modulesAbi}`;
  });
  await check('configuration-ownership', () => { protectedFile(managedLayout.config, env.gid, 0o640); protectedFile(managedLayout.manifest, env.gid, 0o640); protectedFile(managedLayout.environment, env.gid, 0o640); return 'configuration, environment reference and workspace manifest are protected'; });
  await check('release-identity', async () => {
    const current = realpathSync(options.releaseRoot ?? managedLayout.current), prefix = `${managedLayout.releases}${sep}`;
    if (!current.startsWith(prefix)) throw new Error('Current release escapes the managed release directory');
    const manifest = await verifyRelease(current);
    if (resolve(managedLayout.releases, manifest.releaseId) !== current) throw new Error('Current release path does not match its content identity');
    for (const entry of manifest.inventory) { const stat = lstatSync(join(current, entry.path)); if (stat.uid !== 0 || (entry.type !== 'symlink' && (stat.mode & 0o022) !== 0)) throw new Error(`Release entry is not immutable root-owned content: ${entry.path}`); }
    const root = lstatSync(current); if (root.uid !== 0 || (root.mode & 0o022) !== 0) throw new Error('Release root is not immutable root-owned content');
    return manifest.releaseId;
  });
  await check('workspace-boundaries', () => { const result = verifyDeploymentWorkspaces(config); if (!result) throw new Error('Managed workspace manifest was not verified'); return `${result.roots.size} private and ${result.externalRoots.length} external workspace mounts`; });
  await check('docker-control', () => {
    if (!config.runtime.docker) throw new Error('Managed deployment requires Docker configuration');
    accessSync(realpathSync(config.runtime.docker.binary), constants.X_OK); accessSync(dockerSocketPath(config.runtime.docker.host), constants.R_OK | constants.W_OK);
    const result = env.run(config.runtime.docker.binary, ['--host', config.runtime.docker.host, 'image', 'inspect', config.runtime.docker.image]);
    if (result.code !== 0) throw new Error(`Pinned Docker image is unavailable: ${result.stderr.slice(0, 300)}`);
    return config.runtime.docker.image;
  });
  await check('secret-references', () => {
    const missing = requiredSecretReferences(config).filter(name => !process.env[name]?.trim());
    if (missing.length) throw new Error(`Missing environment references: ${missing.join(', ')}`);
    return 'all referenced credentials are present';
  }, options.requireSecrets !== false);
  await check('service-state', () => {
    const result = env.run('/usr/bin/systemctl', ['is-active', 'mate.service']);
    return result.code === 0 ? 'active' : 'inactive';
  }, false);
  return { version: 1, healthy: checks.every(item => item.status !== 'fail'), checks };
}
