import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertConfigurationEvolution, daemonConfigSchema } from '../../src/daemon/config.js';
import { deploymentSpecSchema } from '../../src/deployment/spec.js';
import { createLinuxDeploymentPlan } from '../../src/deployment/linux-plan.js';
import { preflightLinuxDeployment, renderAgentSlice, renderLinuxService, renderLinuxMaintenanceWrapper } from '../../src/deployment/linux-installer.js';
import type { LinuxInstallerHost as InstallerHost } from '../../src/deployment/linux-host.js';

const config = () => daemonConfigSchema.parse({ version: 2, mate: { ownerUserIds: ['owner'], budgets: { maxRuns: 10, maxTokens: 10000, maxCostUsd: 2, runTimeoutMs: 60000 }, agents: [
  { id: 'alice', name: 'Alice', role: 'Research', model: { provider: 'anthropic', id: 'model', apiKeyEnv: 'MODEL_KEY' } },
  { id: 'bob', name: 'Bob', role: 'Writing', model: { provider: 'anthropic', id: 'model', apiKeyEnv: 'MODEL_KEY' } },
] }, adapters: { local: { humans: ['owner'], rooms: [] } }, runtime: { dataDir: '/var/lib/mate', sharedRoot: '/srv/mate/shared', linuxUsers: {
  alice: { uid: 2001, gid: 2001, username: 'mate-alice', home: '/srv/mate/private/alice' },
  bob: { uid: 2002, gid: 2002, username: 'mate-bob', home: '/srv/mate/private/bob' },
}, researchHosts: [] } });
const spec = () => deploymentSpecSchema.parse({ version: 1, release: { source: '/candidate', gitCommit: 'abcdef1234567' }, configSource: '/input/mate.json' });
const facts = { canonical: (path: string) => path, directoryBytes: () => 123456 };

it('plans one ordinary Linux identity per Agent with a shared root, no Docker image or volumes', () => {
  const plan = createLinuxDeploymentPlan(spec(), config(), facts);
  expect(plan.mode).toBe('linux-users');
  expect(plan.agents.map(item => [item.agentId, item.uid, item.home])).toEqual([['alice', 2001, '/srv/mate/private/alice'], ['bob', 2002, '/srv/mate/private/bob']]);
  expect(JSON.stringify(plan)).not.toContain('docker');
  expect(renderAgentSlice()).toContain('TasksMax=128');
  expect(renderLinuxService(plan)).toContain('User=root');
  expect(renderLinuxService(plan)).not.toContain('docker.service');
  expect(renderLinuxMaintenanceWrapper()).toContain('--property=EnvironmentFile=/etc/mate/mate.env');
  expect(renderLinuxMaintenanceWrapper()).toContain('/opt/mate/controller/dist/src/deployment/cli.js "$1"');
  const root = mkdtempSync(join(tmpdir(), 'mate-linux-wrapper-'));
  try { const path = join(root, 'matectl'); writeFileSync(path, renderLinuxMaintenanceWrapper()); expect(() => execFileSync('/bin/sh', ['-n', path])).not.toThrow(); }
  finally { rmSync(root, { recursive: true }); }
});

it('rejects old loopback specs, control overlap, aliased paths and missing Linux usernames', () => {
  expect(() => deploymentSpecSchema.parse({ ...spec(), privateWorkspaces: [{ agentId: 'alice', capacityMiB: 64 }] })).toThrow();
  const overlapping = daemonConfigSchema.parse({ ...config(), runtime: { ...config().runtime, sharedRoot: '/var/lib/mate/shared' } });
  expect(() => createLinuxDeploymentPlan(spec(), overlapping, facts)).toThrow('overlaps');
  expect(() => createLinuxDeploymentPlan(spec(), config(), { ...facts, canonical: path => path === '/candidate' ? '/real-candidate' : path })).toThrow('canonical');
  const nameless = daemonConfigSchema.parse({ ...config(), runtime: { ...config().runtime, linuxUsers: { ...config().runtime.linuxUsers, alice: { uid: 2001, gid: 2001, home: '/srv/mate/private/alice' } } } });
  expect(() => createLinuxDeploymentPlan(spec(), nameless, facts)).toThrow('username');
});

it('keeps Linux UID and private-home identity stable through configuration migration', () => {
  const previous = config(), next = structuredClone(previous);
  next.mate.agents[0]!.role = 'Revised role';
  expect(() => assertConfigurationEvolution(previous, next)).not.toThrow();
  next.runtime.linuxUsers!.alice!.uid = 2020;
  expect(() => assertConfigurationEvolution(previous, next)).toThrow('topology');
});

it('preflights Debian, normal passwd identities, disk, memory and inactive service without mutations', () => {
  const calls: string[] = [];
  const host: InstallerHost = { platform: 'linux', arch: 'x64', node: 'v24.0.0', euid: () => 0, read: () => 'ID=debian\nVERSION_ID="13"\n', assertRootExecutable: path => { calls.push(path); }, run: (binary, args) => {
    calls.push(`${binary} ${args.join(' ')}`);
    if (binary === '/usr/bin/getent') return { code: 0, stdout: `${args[1]}:x:${args[1] === 'mate-alice' ? 2001 : 2002}:${args[1] === 'mate-alice' ? 2001 : 2002}::/srv/mate/private/${args[1] === 'mate-alice' ? 'alice' : 'bob'}:/bin/bash\n`, stderr: '' };
    if (binary === '/usr/bin/id') return { code: 0, stdout: args[1] === 'mate-alice' ? '2001\n' : '2002\n', stderr: '' };
    if (binary === '/usr/bin/node') return { code: 0, stdout: 'v24.0.0\n', stderr: '' };
    return { code: 3, stdout: '', stderr: '' };
  }, directoryBytes: () => 123456, canonical: path => path, availableBytes: () => 1024 ** 3, memoryMiB: () => 2048 };
  expect(preflightLinuxDeployment(spec(), config(), host).mode).toBe('linux-users');
  expect(calls.some(call => call.includes('docker'))).toBe(false);
  expect(() => preflightLinuxDeployment(spec(), config(), { ...host, memoryMiB: () => 128 })).toThrow('memory');
  expect(() => preflightLinuxDeployment(spec(), config(), { ...host, node: 'v24.1.0' })).toThrow('differs');
  expect(() => preflightLinuxDeployment(spec(), config(), { ...host, run: (binary, args) => binary === '/usr/bin/systemctl' ? { code: 0, stdout: '', stderr: '' } : host.run(binary, args) })).toThrow('Stop mate.service');
});
