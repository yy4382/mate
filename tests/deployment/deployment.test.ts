import { execFileSync } from 'node:child_process';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { daemonConfigSchema } from '../../src/daemon/config.js';
import { createDeploymentPlan } from '../../src/deployment/plan.js';
import { createReleaseManifest } from '../../src/deployment/release.js';
import { deploymentSpecSchema } from '../../src/deployment/spec.js';
import { renderMaintenanceWrapper, renderMountUnit, renderService } from '../../src/deployment/systemd.js';
import { initializePublishedVolume, inspectExistingInstallation, preflightDeployment, prepareMountpoint, remainingRequiredBytes, syncPayloadTree, type InstallerHost } from '../../src/deployment/installer.js';
import { isMainModule } from '../../src/main.js';
import { isDeploymentMainModule } from '../../src/deployment/cli.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function config() {
  return daemonConfigSchema.parse({ version: 2, mate: { ownerUserIds: ['owner'], budgets: { maxRuns: 10, maxTokens: 10000, maxCostUsd: 2, runTimeoutMs: 60000 }, agents: [
    { id: 'research', name: 'Research', role: 'Research', model: { provider: 'anthropic', id: 'model', apiKeyEnv: 'MODEL_KEY' } },
    { id: 'writer', name: 'Writer', role: 'Writer', model: { provider: 'anthropic', id: 'model', apiKeyEnv: 'MODEL_KEY' } },
  ] }, adapters: { local: { humans: ['owner'], rooms: [{ id: 'room', agents: ['research', 'writer'], humans: ['owner'] }] } }, runtime: {
    dataDir: '/var/lib/mate', workspaceManifest: '/etc/mate/workspaces.json', docker: { binary: '/usr/bin/docker', host: 'unix:///var/run/docker.sock', image: `sha256:${'a'.repeat(64)}`, resources: { memoryMb: 256, cpus: 1, pids: 64, tmpfsMb: 64 } },
    limits: { maxActiveRuns: 1, maxBackendOperations: 2, workerIdleMs: 300000 }, workspaceGrants: [
      { agentId: 'research', root: '/srv/shared', operations: ['read'] }, { agentId: 'writer', root: '/srv/shared', operations: ['read', 'write'] },
    ], researchHosts: [],
  } });
}
function spec() { return deploymentSpecSchema.parse({ version: 1, release: { source: '/candidate', gitCommit: 'abcdef1234567' }, configSource: '/input/mate.json', privateWorkspaces: [{ agentId: 'writer', capacityMiB: 768 }], externalWorkspaces: [{ root: '/srv/shared', capacityMiB: 1024 }] }); }
const facts = { directoryBytes: () => 100 * 1024 * 1024, canonical: (path: string) => path };

it('plans the fixed managed topology, shared external root, two releases, storage and memory bounds', () => {
  const plan = createDeploymentPlan(spec(), config(), facts);
  expect(plan.workspaces).toEqual([
    expect.objectContaining({ kind: 'private', agentId: 'research', root: '/var/lib/mate/agents/research', capacityBytes: 512 * 1024 * 1024 }),
    expect.objectContaining({ kind: 'private', agentId: 'writer', root: '/var/lib/mate/agents/writer', capacityBytes: 768 * 1024 * 1024 }),
    expect.objectContaining({ kind: 'external', root: '/srv/shared', capacityBytes: 1024 * 1024 * 1024 }),
  ]);
  expect(plan.release).toMatchObject({ retainedCopies: 2, candidateBytes: 100 * 1024 * 1024, reservedBytes: 200 * 1024 * 1024 });
  expect(plan.dockerImage).toEqual({ reference: `sha256:${'a'.repeat(64)}`, installedBytes: null, includedInRequiredBytes: false });
  expect(plan.memory).toEqual({ daemonMiB: 512, maxConcurrentContainers: 2, perContainerMiB: 256, upperBoundMiB: 1024 });
  expect(plan.storage.totalRequiredBytes).toBe(plan.storage.backingBytes + plan.storage.stateReserveBytes + plan.storage.releaseReserveBytes);
});

it('rejects topology gaps, extra entries, aliases, nesting and control-root grants', () => {
  const base = spec(), cfg = config();
  expect(() => createDeploymentPlan({ ...base, externalWorkspaces: [] }, cfg, facts)).toThrow('exactly cover');
  expect(() => createDeploymentPlan({ ...base, externalWorkspaces: [...base.externalWorkspaces, { root: '/srv/extra', capacityMiB: 64 }] }, cfg, facts)).toThrow('exactly cover');
  expect(() => createDeploymentPlan({ ...base, privateWorkspaces: [{ agentId: 'missing', capacityMiB: 64 }] }, cfg, facts)).toThrow('unknown Agent');
  expect(() => createDeploymentPlan(base, cfg, { ...facts, canonical: path => path === '/srv/shared' ? '/srv/alias-target' : path })).toThrow('canonical');
  const nested = daemonConfigSchema.parse({ ...cfg, runtime: { ...cfg.runtime, workspaceGrants: [{ agentId: 'research', root: '/var/lib/mate/shared', operations: ['read'] }] } });
  expect(() => createDeploymentPlan({ ...base, externalWorkspaces: [{ root: '/var/lib/mate/shared', capacityMiB: 64 }] }, nested, facts)).toThrow(/overlap|must not/);
});

it('renders fixed systemd boundaries and a syntax-valid allowlist wrapper', () => {
  const mounts = [{ root: '/var/lib/mate/agents/research', backingFile: '/var/lib/mate-volumes/private-research.ext4', unitName: 'var-lib-mate-agents-research.mount' }];
  const mount = renderMountUnit(mounts[0]!), service = renderService(mounts, 512, ['/srv/shared']), wrapper = renderMaintenanceWrapper(['/srv/shared']);
  expect(mount).toContain('Options=loop,rw,nodev,nosuid');
  expect(service).toContain('SupplementaryGroups=docker'); expect(service).toContain('ProtectSystem=strict'); expect(service).toContain('CapabilityBoundingSet='); expect(service).toContain('MemoryMax=512M'); expect(service).toContain('/srv/shared');
  expect(wrapper).toContain('--property=EnvironmentFile=/etc/mate/mate.env');
  expect(wrapper).toContain('case "${1-}"'); expect(wrapper).not.toContain('eval '); expect(wrapper).not.toContain(' "$@"\n'); expect(wrapper).toContain('checkpoint_name "$2"');
  const root = mkdtempSync(join(tmpdir(), 'mate-wrapper-')); roots.push(root); const path = join(root, 'matectl'); writeFileSync(path, wrapper); expect(() => execFileSync('/bin/sh', ['-n', path])).not.toThrow();
});

it('binds release identity to lockfile, runtime, dependency inventory and native addons', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mate-release-')); roots.push(root); mkdirSync(join(root, 'dist')); mkdirSync(join(root, 'node_modules')); mkdirSync(join(root, 'node_modules', 'pkg')); writeFileSync(join(root, 'dist', 'main.js'), 'one'); writeFileSync(join(root, 'node_modules', 'pkg', 'addon.node'), 'native'); writeFileSync(join(root, 'package.json'), '{}'); writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9'); symlinkSync('pkg', join(root, 'node_modules', 'alias'));
  const runtime = { platform: 'linux' as const, arch: 'x64', node: 'v24.21.0', modulesAbi: '137', packageManager: 'pnpm@10.33.0' };
  const first = await createReleaseManifest(root, 'abcdef1234567', runtime); expect(first.nativeAddons).toHaveLength(1); expect(first.target).toMatchObject({ arch: 'x64', node: 'v24.21.0', modulesAbi: '137' });
  writeFileSync(join(root, 'dist', 'main.js'), 'two'); const second = await createReleaseManifest(root, 'abcdef1234567', runtime); expect(second.releaseId).not.toBe(first.releaseId);
  symlinkSync('/tmp', join(root, 'node_modules', 'escape')); await expect(createReleaseManifest(root, 'abcdef1234567', runtime)).rejects.toThrow('relative');
});

it('accepts pnpm-style hardlinks only when every link is inside the immutable release tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mate-release-links-')); roots.push(root); mkdirSync(join(root, 'dist')); mkdirSync(join(root, 'node_modules')); writeFileSync(join(root, 'dist', 'main.js'), 'main'); writeFileSync(join(root, 'node_modules', 'one.js'), 'shared'); linkSync(join(root, 'node_modules', 'one.js'), join(root, 'node_modules', 'two.js')); writeFileSync(join(root, 'package.json'), '{}'); writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  const runtime = { platform: 'linux' as const, arch: 'x64', node: 'v24.21.0', modulesAbi: '137', packageManager: 'pnpm@10.33.0' };
  await expect(createReleaseManifest(root, 'abcdef1234567', runtime)).resolves.toMatchObject({ version: 1 });
  const outside = join(dirname(root), `${basename(root)}-outside`); writeFileSync(outside, 'external'); linkSync(outside, join(root, 'node_modules', 'outside.js'));
  await expect(createReleaseManifest(root, 'abcdef1234567', runtime)).rejects.toThrow('outside the immutable tree'); rmSync(outside, { force: true });
});

it('preflights through a fake host without mutating it and refuses resource or baseline gaps', () => {
  const calls: string[] = [], host: InstallerHost = { platform: 'linux', arch: 'x64', node: 'v24.21.0', euid: () => 1000, read: () => 'ID=debian\nVERSION_ID="13"\n', assertRootExecutable: path => { calls.push(`binary:${path}`); }, run: (binary, args) => { calls.push(`${binary} ${args.join(' ')}`); return { code: binary === '/usr/bin/systemctl' ? 3 : 0, stdout: '{}', stderr: '' }; }, directoryBytes: () => 1024, canonical: path => path, availableBytes: () => 10 * 1024 ** 3, memoryMiB: () => 4096, existingInstall: () => undefined };
  expect(preflightDeployment(spec(), config(), host).target.os).toBe('debian'); expect(calls.some(value => value.includes('image inspect'))).toBe(true); expect(calls.filter(value => value.startsWith('/')).every(value => !value.includes('mkfs'))).toBe(true);
  expect(() => preflightDeployment(spec(), config(), { ...host, memoryMiB: () => 100 })).toThrow('memory');
  expect(() => preflightDeployment(spec(), config(), { ...host, platform: 'darwin' })).toThrow('Debian 13');
  const plan = createDeploymentPlan(spec(), config(), host), consumedBytes = plan.storage.totalRequiredBytes - 4096;
  expect(() => preflightDeployment(spec(), config(), { ...host, availableBytes: () => 4096, existingInstall: () => ({ inputIdentity: 'identity-does-not-match', complete: false, consumedBytes }) })).toThrow('differs');
  expect(remainingRequiredBytes(plan, { inputIdentity: 'same', complete: false, consumedBytes })).toBe(4096);
  expect(remainingRequiredBytes(plan, { inputIdentity: 'same', releaseId: 'a'.repeat(64), complete: true, consumedBytes: 0 })).toBe(0);
});

it('finishes ownership and unmount when resuming an already-mounted workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'mate-volume-resume-')); roots.push(root); const mountRoot = join(root, 'workspace'), backingFile = join(root, 'workspace.ext4');
  mkdirSync(mountRoot, { mode: 0o700 }); chmodSync(mountRoot, 0o700); writeFileSync(backingFile, 'backing');
  const calls: string[] = [], host = {
    run: (binary: string, args: readonly string[]) => { calls.push(`${binary} ${args.join(' ')}`); if (binary === '/usr/bin/findmnt') return { code: 0, stdout: `${mountRoot} /dev/loop7 ext4 rw,nodev,nosuid,relatime\n`, stderr: '' }; if (binary === '/usr/sbin/losetup') return { code: 0, stdout: '/dev/loop7\n', stderr: '' }; return { code: 0, stdout: '', stderr: '' }; },
  } as InstallerHost;
  initializePublishedVolume(host, { kind: 'external', root: mountRoot, backingFile, capacityBytes: 64 }, process.getuid!(), process.getgid!());
  expect(calls).toContain(`/usr/bin/chown ${process.getuid!()}:${process.getgid!()} ${mountRoot}`); expect(calls).toContain(`/usr/bin/chmod 0700 ${mountRoot}`); expect(calls).toContain(`/usr/bin/umount ${mountRoot}`);
  const wrong = { ...host, run: (binary: string, args: readonly string[]) => binary === '/usr/bin/findmnt' ? { code: 0, stdout: `${mountRoot} /dev/loop8 ext4 rw,nodev,nosuid\n`, stderr: '' } : binary === '/usr/sbin/losetup' ? { code: 0, stdout: '/dev/loop7\n', stderr: '' } : { code: 0, stdout: '', stderr: '' } } as InstallerHost;
  expect(() => initializePublishedVolume(wrong, { kind: 'external', root: mountRoot, backingFile, capacityBytes: 64 }, process.getuid!(), process.getgid!())).toThrow('managed backing');
});

it('persists a release payload tree containing files, directories and symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'mate-payload-sync-')); roots.push(root); mkdirSync(join(root, 'nested')); writeFileSync(join(root, 'nested', 'file'), 'payload'); symlinkSync('nested/file', join(root, 'link'));
  expect(() => syncPayloadTree(root)).not.toThrow();
});

it('recognizes the recoverable window after current is published and before the completion marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'mate-install-window-')); roots.push(root); const releases = join(root, 'releases'), control = join(root, 'control'); mkdirSync(releases); mkdirSync(control);
  const releaseId = 'a'.repeat(64), release = join(releases, releaseId); mkdirSync(release); writeFileSync(join(release, 'payload'), 'ready'); symlinkSync(release, join(root, 'current'));
  const releaseStat = lstatSync(release);
  const journalPath = join(control, 'install-v1.json'), completed = join(control, 'installation.json');
  writeFileSync(journalPath, `${JSON.stringify({ version: 1, transaction: '11111111-1111-4111-8111-111111111111', inputIdentity: 'b'.repeat(64), uid: process.getuid!(), gid: process.getgid!(), directories: [], release: { stage: join(releases, '.stage'), stageDev: releaseStat.dev, stageIno: releaseStat.ino, releaseId, status: 'published' }, volumes: [], phase: 'published' })}\n`, { mode: 0o600 }); chmodSync(journalPath, 0o600);
  const state = inspectExistingInstallation({ bootstrapJournal: join(root, 'bootstrap.json'), controlJournal: journalPath, completed, current: join(root, 'current'), releases }, process.getuid!(), process.getgid!());
  expect(state).toMatchObject({ inputIdentity: 'b'.repeat(64), releaseId, complete: false }); expect(state!.consumedBytes).toBeGreaterThan(0);
  writeFileSync(completed, `${JSON.stringify({ version: 1, inputIdentity: 'b'.repeat(64), releaseId })}\n`, { mode: 0o600 }); chmodSync(completed, 0o600);
  expect(inspectExistingInstallation({ bootstrapJournal: join(root, 'bootstrap.json'), controlJournal: journalPath, completed, current: join(root, 'current'), releases }, process.getuid!(), process.getgid!())).toMatchObject({ complete: false, releaseId });
});

it('credits journal-bound resources renamed before their journal status advances', () => {
  const root = mkdtempSync(join(tmpdir(), 'mate-install-rename-')); roots.push(root); const releases = join(root, 'releases'), control = join(root, 'control'), mountRoot = join(root, 'mount'); mkdirSync(releases); mkdirSync(control); mkdirSync(mountRoot);
  const releaseId = 'c'.repeat(64), release = join(releases, releaseId); mkdirSync(release); writeFileSync(join(release, 'payload'), Buffer.alloc(1024 * 1024, 1)); const releaseStat = lstatSync(release);
  const backingFile = join(root, 'workspace.ext4'); writeFileSync(backingFile, Buffer.alloc(1024 * 1024, 2), { mode: 0o600 }); chmodSync(backingFile, 0o600); const backingStat = lstatSync(backingFile), rootStat = lstatSync(mountRoot);
  const journalPath = join(control, 'install-v1.json');
  writeFileSync(journalPath, `${JSON.stringify({ version: 1, transaction: '22222222-2222-4222-8222-222222222222', inputIdentity: 'd'.repeat(64), uid: process.getuid!(), gid: process.getgid!(), directories: [], release: { stage: join(releases, '.stage'), stageDev: releaseStat.dev, stageIno: releaseStat.ino, releaseId, status: 'copied' }, volumes: [{ backingFile, stage: join(root, '.stage.ext4'), stageDev: backingStat.dev, stageIno: backingStat.ino, root: mountRoot, rootExisted: true, rootDev: rootStat.dev, rootIno: rootStat.ino, status: 'formatted' }], phase: 'resources' })}\n`, { mode: 0o600 }); chmodSync(journalPath, 0o600);
  const state = inspectExistingInstallation({ bootstrapJournal: join(root, 'bootstrap.json'), controlJournal: journalPath, completed: join(control, 'installation.json'), current: join(root, 'current'), releases }, process.getuid!(), process.getgid!());
  expect(state).toMatchObject({ complete: false, releaseId }); expect(state!.consumedBytes).toBeGreaterThanOrEqual(2 * 1024 * 1024);
});

it('binds and completes a transaction-created mountpoint left by a mkdir interruption', () => {
  const parent = mkdtempSync(join(tmpdir(), 'mate-mountpoint-window-')); roots.push(parent); chmodSync(parent, 0o700); const mountRoot = join(parent, 'workspace'); mkdirSync(mountRoot, { mode: 0o700 }); chmodSync(mountRoot, 0o700);
  const backingFile = join(parent, 'workspace.ext4'), stage = join(parent, '.stage.ext4'); writeFileSync(backingFile, 'backing', { mode: 0o600 }); const backing = lstatSync(backingFile), journalPath = join(parent, 'journal.json');
  const journal = { version: 1 as const, transaction: '33333333-3333-4333-8333-333333333333', inputIdentity: 'e'.repeat(64), uid: process.getuid!(), gid: process.getgid!(), directories: [], release: { stage: join(parent, '.release'), status: 'planned' as const }, volumes: [{ backingFile, stage, stageDev: backing.dev, stageIno: backing.ino, root: mountRoot, rootExisted: false, status: 'published' as const }], phase: 'resources' as const };
  writeFileSync(journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 }); chmodSync(journalPath, 0o600);
  const host = { run: () => ({ code: 1, stdout: '', stderr: 'not mounted' }) } as unknown as InstallerHost;
  const resumed = prepareMountpoint(host, { kind: 'external', root: mountRoot, backingFile, capacityBytes: 64 }, process.getuid!(), process.getgid!(), journalPath, journal, 0, { uid: process.getuid!(), gid: process.getgid!() });
  expect(resumed.volumes[0]).toMatchObject({ rootExisted: false, rootDev: lstatSync(mountRoot).dev, rootIno: lstatSync(mountRoot).ino });
});

it('allows preflight accounting to reach recovery for planned staging created before inode binding', () => {
  const root = mkdtempSync(join(tmpdir(), 'mate-unbound-staging-')); roots.push(root); const releases = join(root, 'releases'), control = join(root, 'control'), releaseStage = join(releases, '.stage'), volumeStage = join(root, '.volume'); mkdirSync(releases); mkdirSync(control); mkdirSync(releaseStage); writeFileSync(join(releaseStage, 'partial'), Buffer.alloc(4096, 1)); writeFileSync(volumeStage, Buffer.alloc(4096, 2), { mode: 0o600 }); chmodSync(volumeStage, 0o600);
  const mountRoot = join(root, 'mount'), journalPath = join(control, 'install-v1.json');
  writeFileSync(journalPath, `${JSON.stringify({ version: 1, transaction: '44444444-4444-4444-8444-444444444444', inputIdentity: 'f'.repeat(64), uid: process.getuid!(), gid: process.getgid!(), directories: [], release: { stage: releaseStage, status: 'planned' }, volumes: [{ backingFile: join(root, 'workspace.ext4'), stage: volumeStage, root: mountRoot, rootExisted: false, status: 'planned' }], phase: 'resources' })}\n`, { mode: 0o600 }); chmodSync(journalPath, 0o600);
  const state = inspectExistingInstallation({ bootstrapJournal: join(root, 'bootstrap.json'), controlJournal: journalPath, completed: join(control, 'installation.json'), current: join(root, 'current'), releases }, process.getuid!(), process.getgid!());
  expect(state).toMatchObject({ complete: false }); expect(state!.consumedBytes).toBeGreaterThan(0);
});

it('recognizes a deployed CLI reached through the current release symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'mate-main-link-')); roots.push(root); mkdirSync(join(root, 'release')); const main = join(root, 'release', 'main.js'); writeFileSync(main, ''); symlinkSync(join(root, 'release'), join(root, 'current'));
  expect(isMainModule(join(root, 'current', 'main.js'), pathToFileURL(realpathSync(main)).href)).toBe(true);
  expect(isDeploymentMainModule(join(root, 'current', 'main.js'), pathToFileURL(realpathSync(main)).href)).toBe(true);
});
