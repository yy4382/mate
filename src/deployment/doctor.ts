import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { slackRuntimeConfig, type DaemonConfig } from '../daemon/config.js';
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

export interface DoctorOptions { releaseRoot?: string; requireSecrets?: boolean; legacyQuotaConfig?: boolean }

export async function runDoctor(config: DaemonConfig, env: DoctorEnvironment = nodeEnvironment(), options: DoctorOptions = {}): Promise<DoctorReport> {
  if (!config.runtime.linuxUsers || !config.runtime.sharedRoot) throw new Error('Debian Linux-user deployment configuration required');
  const checks: DoctorCheck[] = [];
  if(options.legacyQuotaConfig)checks.push({name:'legacy-model-quotas',status:'info',detail:'Legacy mate.budgets quotas are ignored; only runTimeoutMs is used.'});
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
  await check('configuration-ownership', () => {
    protectedFile(managedLayout.config, 0, 0o600); protectedFile(managedLayout.environment, 0, 0o600); return 'configuration and credentials are root-only';
  });
  await check('release-identity', async () => {
    const current = realpathSync(options.releaseRoot ?? managedLayout.current), prefix = `${managedLayout.releases}${sep}`;
    if (!current.startsWith(prefix)) throw new Error('Current release escapes the managed release directory');
    const manifest = await verifyRelease(current,undefined,{platform:env.platform,arch:env.arch,node:env.node,modulesAbi:env.modulesAbi,packageManager:'pnpm@10.33.0'});
    if (resolve(managedLayout.releases, manifest.releaseId) !== current) throw new Error('Current release path does not match its content identity');
    for (const entry of manifest.inventory) { const stat = lstatSync(join(current, entry.path)); if (stat.uid !== 0 || (entry.type !== 'symlink' && (stat.mode & 0o022) !== 0)) throw new Error(`Release entry is not immutable root-owned content: ${entry.path}`); }
    const root = lstatSync(current); if (root.uid !== 0 || (root.mode & 0o022) !== 0) throw new Error('Release root is not immutable root-owned content');
    return manifest.releaseId;
  });
  await check('linux-identities', () => {
    for (const [agentId, user] of Object.entries(config.runtime.linuxUsers!)) {
      if (!user.username) throw new Error(`${agentId}: managed deployment requires a username`);
      const account = env.run('/usr/bin/getent', ['passwd', user.username]);
      const fields = account.stdout.trim().split(':');
      if (account.code !== 0 || fields.length !== 7 || Number(fields[2]) !== user.uid || Number(fields[3]) !== user.gid || fields[5] !== user.home) throw new Error(`${agentId}: Linux account differs from configuration`);
      const home = lstatSync(user.home);
      if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== user.uid || home.gid !== user.gid || (home.mode & 0o777) !== 0o700) throw new Error(`${agentId}: private directory ownership or mode differs: ${user.home}`);
      const memory = lstatSync(join(user.home, 'MEMORY.md'));
      if (!memory.isFile() || memory.isSymbolicLink() || memory.uid !== user.uid || memory.gid !== user.gid || (memory.mode & 0o777) !== 0o600) throw new Error(`${agentId}: private memory entry differs`);
      const sharedWork = lstatSync(join(config.runtime.sharedRoot!, agentId));
      if (!sharedWork.isDirectory() || sharedWork.isSymbolicLink() || sharedWork.uid !== user.uid || sharedWork.gid !== user.gid || (sharedWork.mode & 0o777) !== 0o755) throw new Error(`${agentId}: shared work directory differs`);
      const slice = env.run('/usr/bin/systemctl', ['show', `mate-agent-${user.uid}.slice`, '-p', 'LoadState', '-p', 'MemoryMax', '-p', 'TasksMax', '-p', 'CPUQuotaPerSecUSec', '--no-pager']);
      const values = Object.fromEntries(slice.stdout.split('\n').filter(Boolean).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
      if (slice.code !== 0 || values.LoadState !== 'loaded' || !Number.isFinite(Number(values.MemoryMax)) || Number(values.MemoryMax) < 1 || !Number.isFinite(Number(values.TasksMax)) || Number(values.TasksMax) < 1 || !values.CPUQuotaPerSecUSec || values.CPUQuotaPerSecUSec === 'infinity') throw new Error(`${agentId}: finite process quotas are unavailable`);
    }
    const root = lstatSync(config.runtime.dataDir), state = lstatSync(join(config.runtime.dataDir, 'state')), shared = lstatSync(config.runtime.sharedRoot!);
    if ([root, state].some(stat => !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o777) !== 0o700)) throw new Error('Mate data and state must be root-only');
    if (!shared.isDirectory() || shared.isSymbolicLink() || shared.uid !== 0 || (shared.mode & 0o777) !== 0o755) throw new Error('Shared root must be root-owned and peer-readable');
    return `${Object.keys(config.runtime.linuxUsers!).length} Linux identities and private homes checked`;
  });
  await check('system-approval', () => {
    const eligible = config.runtime.systemAgents ?? [];
    if (eligible.length) {
      const slack = slackRuntimeConfig(config);
      if (!slack?.ownerUserIds.length || eligible.some(id => !config.adapters.slack?.bindings.some(binding => binding.agentId === id))) throw new Error('System-eligible Agents need a mapped Slack owner and Agent installation for approval');
    }
    return `${eligible.length} Agent(s) eligible to request individual owner-approved system commands`;
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
