import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync, constants, existsSync, fchmodSync, fchownSync, fdatasyncSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, statfsSync, symlinkSync, unlinkSync, writeFileSync, chownSync, chmodSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { daemonConfigSchema, type DaemonConfig } from '../daemon/config.js';
import { createReleaseManifest, verifyRelease, type ReleaseManifest } from './release.js';
import { createDeploymentPlan, type DeploymentPlan, type PlannedWorkspace } from './plan.js';
import { deploymentSpecSchema, type DeploymentSpec } from './spec.js';
import { assertSafeUnitName, managedLayout, renderMaintenanceWrapper, renderMountUnit, renderService, type ManagedMount } from './systemd.js';

const journalSchema = z.object({
  version: z.literal(1), transaction: z.string().uuid(), inputIdentity: z.string().regex(/^[a-f0-9]{64}$/), uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(),
  directories: z.array(z.object({ path: z.string(), uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(), mode: z.number().int().nonnegative(), existed: z.boolean(), dev: z.number().int().nonnegative().optional(), ino: z.number().int().positive().optional(), status: z.enum(['planned', 'complete']) }).strict()),
  release: z.object({ stage: z.string(), stageDev: z.number().int().nonnegative().optional(), stageIno: z.number().int().positive().optional(), releaseId: z.string().regex(/^[a-f0-9]{64}$/).optional(), status: z.enum(['planned', 'copied', 'published']) }).strict(),
  volumes: z.array(z.object({ backingFile: z.string(), stage: z.string(), stageDev: z.number().int().nonnegative().optional(), stageIno: z.number().int().positive().optional(), root: z.string(), rootExisted: z.boolean(), rootDev: z.number().int().nonnegative().optional(), rootIno: z.number().int().positive().optional(), status: z.enum(['planned', 'formatted', 'published', 'initialized']) }).strict()),
  phase: z.enum(['resources', 'units', 'mounted', 'probed', 'published']),
}).strict();
type InstallJournal = z.infer<typeof journalSchema>;
const completedSchema = z.object({ version: z.literal(1), inputIdentity: z.string().regex(/^[a-f0-9]{64}$/), releaseId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const completedPath = join(managedLayout.data, 'control', 'installation.json');
const bootstrapJournalPath = '/var/lib/.mate-install-v1.json';
const controlJournalPath = join(managedLayout.data, 'control', 'install-v1.json');
export interface InstallationPaths { bootstrapJournal: string; controlJournal: string; completed: string; current: string; releases: string }
const installationPaths: InstallationPaths = { bootstrapJournal: bootstrapJournalPath, controlJournal: controlJournalPath, completed: completedPath, current: managedLayout.current, releases: managedLayout.releases };
function pathExists(path: string): boolean { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
function canonicalFuturePath(path: string): string {
  const raw = resolve(path), tail: string[] = []; let current = raw;
  while (!pathExists(current)) { const parent = dirname(current); if (parent === current) throw new Error(`Cannot resolve deployment path: ${path}`); tail.unshift(basename(current)); current = parent; }
  return resolve(realpathSync(current), ...tail);
}

export interface CommandResult { code: number; stdout: string; stderr: string }
export interface ExistingInstallation {
  inputIdentity: string;
  releaseId?: string;
  complete: boolean;
  consumedBytes: number;
}
export interface InstallerHost {
  platform: NodeJS.Platform;
  arch: string;
  node: string;
  euid(): number;
  read(path: string): string;
  assertRootExecutable(path: string): void;
  run(binary: string, args: readonly string[]): CommandResult;
  directoryBytes(path: string): number;
  canonical(path: string): string;
  dockerImageBytes?(reference: string): number | undefined;
  availableBytes(path: string): number;
  memoryMiB(): number;
  existingInstall(): ExistingInstallation | undefined;
}

function run(binary: string, args: readonly string[]): CommandResult {
  const result = spawnSync(binary, [...args], { encoding: 'utf8', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, maxBuffer: 4 * 1024 * 1024 });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? String(result.error ?? '') };
}
function directoryBytes(path: string): number {
  let total = 0;
  const visit = (current: string): void => { const stat = lstatSync(current); if (stat.isFile()) total += stat.blocks * 512; else if (stat.isDirectory()) for (const name of readdirSync(current)) visit(join(current, name)); };
  visit(path); return total;
}
function boundResourceBytes(candidates: readonly string[], dev: number | undefined, ino: number | undefined, kind: 'file' | 'directory', allowUnbound: boolean): number {
  const existing = candidates.filter(pathExists).map(path => ({ path, stat: lstatSync(path) }));
  if (!existing.length) return 0;
  if (dev === undefined || ino === undefined) {
    if (existing.length > 1) throw new Error(`Unbound ${kind} resource exists at both staging and final paths`);
    const item = existing[0]!, matchesKind = kind === 'file' ? item.stat.isFile() && !item.stat.isSymbolicLink() : item.stat.isDirectory() && !item.stat.isSymbolicLink();
    if (!allowUnbound || !matchesKind) throw new Error(`Existing ${kind} resource lacks a journal identity`);
    return kind === 'file' ? item.stat.blocks * 512 : directoryBytes(item.path);
  }
  for (const item of existing) {
    const matchesKind = kind === 'file' ? item.stat.isFile() && !item.stat.isSymbolicLink() : item.stat.isDirectory() && !item.stat.isSymbolicLink();
    if (!matchesKind || item.stat.dev !== dev || item.stat.ino !== ino) throw new Error(`Journal-bound ${kind} resource identity differs: ${item.path}`);
  }
  if (existing.length > 1 && new Set(existing.map(item => `${item.stat.dev}:${item.stat.ino}`)).size !== 1) throw new Error(`Journal-bound ${kind} resource exists at both staging and final paths with different identities`);
  return kind === 'file' ? existing[0]!.stat.blocks * 512 : directoryBytes(existing[0]!.path);
}
export function inspectExistingInstallation(paths: InstallationPaths = installationPaths, rootUid = 0, rootGid = 0): ExistingInstallation | undefined {
  const journals = [paths.bootstrapJournal, paths.controlJournal].filter(pathExists);
  if (journals.length > 1) throw new Error('Both bootstrap and control install journals exist');
  if (journals.length === 1) {
    const journalPath = journals[0]!; owner(journalPath, rootUid, rootGid, 0o600, 'file');
    const journal = journalSchema.parse(JSON.parse(readFileSync(journalPath, 'utf8')));
    if (pathExists(paths.current)) {
      if (!journal.release.releaseId) throw new Error('Unfinished installation current release has no journal identity');
      const current = lstatSync(paths.current);
      if (!current.isSymbolicLink() || realpathSync(paths.current) !== realpathSync(join(paths.releases, journal.release.releaseId))) throw new Error('Unfinished installation journal and current release differ');
    }
    if (pathExists(paths.completed)) {
      owner(paths.completed, rootUid, rootGid, 0o600, 'file'); const completed = completedSchema.parse(JSON.parse(readFileSync(paths.completed, 'utf8')));
      if (completed.inputIdentity !== journal.inputIdentity || completed.releaseId !== journal.release.releaseId) throw new Error('Installation marker and unfinished journal differ');
    }
    const releaseFinal = journal.release.releaseId ? join(paths.releases, journal.release.releaseId) : undefined;
    let releaseBytes: number;
    if (journal.release.status === 'planned') releaseBytes = boundResourceBytes([journal.release.stage], journal.release.stageDev, journal.release.stageIno, 'directory', true);
    else if (journal.release.status === 'copied') {
      const hasStage = pathExists(journal.release.stage), stagedBytes = boundResourceBytes([journal.release.stage], journal.release.stageDev, journal.release.stageIno, 'directory', false);
      const finalBytes = releaseFinal ? boundResourceBytes([releaseFinal], hasStage ? undefined : journal.release.stageDev, hasStage ? undefined : journal.release.stageIno, 'directory', hasStage) : 0;
      releaseBytes = stagedBytes + finalBytes;
    } else releaseBytes = releaseFinal ? boundResourceBytes([releaseFinal], journal.release.stageDev, journal.release.stageIno, 'directory', false) : 0;
    const volumeBytes = journal.volumes.reduce((sum, volume) => {
      return sum + boundResourceBytes([volume.stage, volume.backingFile], volume.stageDev, volume.stageIno, 'file', volume.status === 'planned');
    }, 0);
    return { inputIdentity: journal.inputIdentity, ...(journal.release.releaseId ? { releaseId: journal.release.releaseId } : {}), complete: false, consumedBytes: releaseBytes + volumeBytes };
  }
  if (!pathExists(paths.completed)) { if (pathExists(paths.current)) throw new Error('Existing current release is not a V2c managed installation'); return undefined; }
  owner(paths.completed, rootUid, rootGid, 0o600, 'file'); const value = completedSchema.parse(JSON.parse(readFileSync(paths.completed, 'utf8')));
  const current = lstatSync(paths.current); if (!current.isSymbolicLink() || realpathSync(paths.current) !== realpathSync(join(paths.releases, value.releaseId))) throw new Error('Managed installation marker and current release differ');
  return { ...value, complete: true, consumedBytes: 0 };
}
export const nodeInstallerHost = (): InstallerHost => ({
  platform: process.platform, arch: process.arch, node: process.version,
  euid: () => process.geteuid?.() ?? -1, run, directoryBytes, canonical: canonicalFuturePath,
  read: path => readFileSync(path, 'utf8'), assertRootExecutable: path => { const link = lstatSync(path), stat = lstatSync(realpathSync(path)); if ((!link.isFile() && !link.isSymbolicLink()) || link.uid !== 0 || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0) throw new Error(`Host executable is not protected: ${path}`); },
  availableBytes: path => { const stat = statfsSync(path); return Number(BigInt(stat.bavail) * BigInt(stat.bsize)); },
  dockerImageBytes: reference => {
    const inspected = run('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', 'image', 'inspect', '--format={{.Size}}', reference]);
    if (inspected.code !== 0) return undefined;
    const bytes = Number(inspected.stdout.trim()); return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
  },
  memoryMiB: () => { const match = /^MemTotal:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8')); if (!match) throw new Error('Cannot read host memory'); return Math.floor(Number(match[1]) / 1024); },
  existingInstall: () => inspectExistingInstallation(),
});

function checked(host: InstallerHost, binary: string, args: readonly string[], label: string): string {
  const result = host.run(binary, args); if (result.code !== 0) throw new Error(`${label}: ${(result.stderr.trim() || result.stdout.trim()).slice(0, 1000)}`); return result.stdout.trim();
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function inputIdentity(spec: DeploymentSpec, config: DaemonConfig, plan: DeploymentPlan, host: InstallerHost): string { return hash(stable({ spec, config, plan, environment: spec.environmentSource ? host.read(spec.environmentSource) : '' })); }
function fsyncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function fsyncFile(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function syncPayloadTree(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) { fsyncFile(path); return; }
  if (!stat.isDirectory()) throw new Error(`Cannot persist unsupported payload entry: ${path}`);
  for (const name of readdirSync(path)) syncPayloadTree(join(path, name));
  fsyncDirectory(path);
}
function ensureDirectory(path: string, uid: number, gid: number, mode: number): void {
  if (!existsSync(path)) { mkdirSync(path, { mode }); chownSync(path, uid, gid); chmodSync(path, mode); fsyncDirectory(dirname(path)); }
  const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o777) !== mode) throw new Error(`Managed directory identity mismatch: ${path}`);
}
function atomicExact(path: string, content: string, uid: number, gid: number, mode: number): void {
  if (existsSync(path)) { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o777) !== mode || readFileSync(path, 'utf8') !== content) throw new Error(`Existing managed file differs: ${path}`); return; }
  const temporary = join(dirname(path), `.${basename(path)}.mate-${randomUUID()}`), fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try { writeFileSync(fd, content); fdatasyncSync(fd); fchownSync(fd, uid, gid); fchmodSync(fd, mode); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path); fsyncDirectory(dirname(path));
}
function replaceJournal(path: string, journal: InstallJournal): void {
  const content = `${JSON.stringify(journalSchema.parse(journal), null, 2)}\n`, temporary = `${path}.new`;
  if (existsSync(temporary)) { const stat = lstatSync(temporary); if (!stat.isFile() || stat.uid !== 0) throw new Error('Install journal temporary path is unsafe'); unlinkSync(temporary); }
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, content); fdatasyncSync(fd); fchmodSync(fd, 0o600); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path); fsyncDirectory(dirname(path));
}
function owner(path: string, uid: number, gid: number, mode: number, kind: 'file' | 'directory'): void {
  const stat = lstatSync(path), matches = kind === 'file' ? stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 : stat.isDirectory() && !stat.isSymbolicLink();
  if (!matches || stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o777) !== mode) throw new Error(`Managed ${kind} identity mismatch: ${path}`);
}

export function readDeploymentInputs(specPath: string): { spec: DeploymentSpec; config: DaemonConfig } {
  const spec = deploymentSpecSchema.parse(JSON.parse(readFileSync(realpathSync(specPath), 'utf8'))), config = daemonConfigSchema.parse(JSON.parse(readFileSync(realpathSync(spec.configSource), 'utf8')));
  return { spec, config };
}

export function preflightDeployment(spec: DeploymentSpec, config: DaemonConfig, host: InstallerHost = nodeInstallerHost()): DeploymentPlan {
  const plan = createDeploymentPlan(spec, config, host), os = Object.fromEntries(host.read('/etc/os-release').split('\n').filter(line => line.includes('=')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, '')]; }));
  if (host.platform !== 'linux' || host.arch !== 'x64' || os.ID !== 'debian' || os.VERSION_ID !== '13' || !/^v24\./.test(host.node)) throw new Error('Supported installer host is Debian 13 x86_64 with Node 24');
  for (const binary of ['/usr/bin/systemctl', '/usr/bin/systemd-run', '/usr/bin/systemd-escape', '/usr/bin/systemd-sysusers', '/usr/bin/getent', '/usr/sbin/mkfs.ext4', '/usr/bin/fallocate', '/usr/bin/mount', '/usr/bin/umount', '/usr/bin/findmnt', '/usr/sbin/losetup', '/usr/sbin/blkid', '/usr/bin/docker']) host.assertRootExecutable(binary);
  checked(host, '/usr/bin/docker', ['--host', config.runtime.docker!.host, 'image', 'inspect', config.runtime.docker!.image], 'Pinned Docker image is unavailable');
  const existing = host.existingInstall(), identity = inputIdentity(spec, config, plan, host);
  if (existing && existing.inputIdentity !== identity) throw new Error('Existing managed installation differs; upgrades belong to the V2d transaction');
  const requiredBytes = remainingRequiredBytes(plan, existing);
  if (requiredBytes > 0 && host.availableBytes('/') < requiredBytes) throw new Error(`Insufficient disk space for remaining deployment resources (${requiredBytes} bytes required)`);
  if (host.memoryMiB() < plan.memory.upperBoundMiB) throw new Error('Host memory is below the configured daemon and concurrent container upper bound');
  const active = host.run('/usr/bin/systemctl', ['is-active', '--quiet', 'mate.service']); if (active.code === 0) throw new Error('mate.service must be stopped before installation');
  return plan;
}

export function remainingRequiredBytes(plan: DeploymentPlan, existing: ExistingInstallation | undefined): number {
  if (existing?.complete) return 0;
  return Math.max(0, plan.storage.totalRequiredBytes - (existing?.consumedBytes ?? 0));
}

function serviceIdentity(host: InstallerHost): { uid: number; gid: number } {
  ensureDirectory('/etc/sysusers.d', 0, 0, 0o755);
  atomicExact('/etc/sysusers.d/mate.conf', 'u mate - "Mate daemon" /var/lib/mate /usr/sbin/nologin\n', 0, 0, 0o644);
  checked(host, '/usr/bin/systemd-sysusers', ['/etc/sysusers.d/mate.conf'], 'Cannot create Mate service identity');
  const uid = Number(checked(host, '/usr/bin/id', ['-u', 'mate'], 'Cannot resolve mate uid')), gid = Number(checked(host, '/usr/bin/id', ['-g', 'mate'], 'Cannot resolve mate gid'));
  const passwd = checked(host, '/usr/bin/getent', ['passwd', 'mate'], 'Cannot inspect mate account').split(':');
  if (uid <= 0 || gid <= 0 || passwd.length !== 7 || passwd[0] !== 'mate' || Number(passwd[2]) !== uid || Number(passwd[3]) !== gid || passwd[5] !== '/var/lib/mate' || passwd[6] !== '/usr/sbin/nologin') throw new Error('mate must be a dedicated non-root account with the managed home and nologin shell');
  const groups = checked(host, '/usr/bin/id', ['-Gn', 'mate'], 'Cannot inspect mate groups').split(/\s+/); if (groups.length !== 1 || groups[0] !== 'mate') throw new Error('mate must not have permanent supplementary groups');
  return { uid, gid };
}

function layoutEntries(uid: number, gid: number): InstallJournal['directories'] {
  return [
    { path: '/opt/mate', uid: 0, gid: 0, mode: 0o755 }, { path: managedLayout.releases, uid: 0, gid: 0, mode: 0o755 },
    { path: managedLayout.configDir, uid: 0, gid, mode: 0o750 }, { path: managedLayout.data, uid, gid, mode: 0o700 },
    ...['state', 'agents', 'control'].map(part => ({ path: join(managedLayout.data, part), uid, gid, mode: 0o700 })),
    { path: managedLayout.volumes, uid: 0, gid, mode: 0o710 }, { path: managedLayout.checkpoints, uid: 0, gid, mode: 0o750 },
  ].map(item => {
    if (!pathExists(item.path)) return { ...item, existed: false, status: 'planned' as const };
    owner(item.path, item.uid, item.gid, item.mode, 'directory'); const stat = lstatSync(item.path); return { ...item, existed: true, dev: stat.dev, ino: stat.ino, status: 'complete' as const };
  });
}

function mountpointIntent(root: string): Pick<InstallJournal['volumes'][number], 'root' | 'rootExisted' | 'rootDev' | 'rootIno'> {
  if (!pathExists(root)) return { root, rootExisted: false };
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(root).length !== 0) throw new Error(`Existing workspace mountpoint must be an empty directory: ${root}`);
  return { root, rootExisted: true, rootDev: stat.dev, rootIno: stat.ino };
}

function prepareLayout(journalPath: string, journal: InstallJournal): InstallJournal {
  for (let index = 0; index < journal.directories.length; index++) {
    let entry = journal.directories[index]!;
    if (entry.status === 'complete') { const stat = lstatSync(entry.path); if (stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error(`Managed directory identity changed: ${entry.path}`); owner(entry.path, entry.uid, entry.gid, entry.mode, 'directory'); continue; }
    if (!pathExists(entry.path)) mkdirSync(entry.path, { mode: entry.mode });
    const stat = lstatSync(entry.path), provisionalOwner = stat.uid === 0 && stat.gid === 0, finalOwner = stat.uid === entry.uid && stat.gid === entry.gid && (stat.mode & 0o777) === entry.mode;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (!provisionalOwner && !finalOwner) || readdirSync(entry.path).length !== 0) throw new Error(`Planned managed directory is not a new empty transaction directory: ${entry.path}`);
    chownSync(entry.path, entry.uid, entry.gid); chmodSync(entry.path, entry.mode); fsyncDirectory(dirname(entry.path));
    const completed = lstatSync(entry.path); entry = { ...entry, dev: completed.dev, ino: completed.ino, status: 'complete' }; journal = { ...journal, directories: journal.directories.map((value, at) => at === index ? entry : value) }; replaceJournal(journalPath, journal);
  }
  return journal;
}

async function publishRelease(host: InstallerHost, spec: DeploymentSpec, journalPath: string, journal: InstallJournal): Promise<{ journal: InstallJournal; manifest: ReleaseManifest; path: string }> {
  const source = realpathSync(spec.release.source), item = journal.release;
  if (item.status === 'planned') {
    if (!existsSync(item.stage)) {
      if (item.stageDev !== undefined) throw new Error('Recorded release staging directory disappeared'); mkdirSync(item.stage, { mode: 0o755 }); fsyncDirectory(dirname(item.stage)); const created = lstatSync(item.stage);
      journal = { ...journal, release: { ...item, stageDev: created.dev, stageIno: created.ino } }; replaceJournal(journalPath, journal);
    } else if (item.stageDev === undefined) { owner(item.stage, 0, 0, 0o755, 'directory'); const created = lstatSync(item.stage); journal = { ...journal, release: { ...item, stageDev: created.dev, stageIno: created.ino } }; replaceJournal(journalPath, journal); }
    const currentItem = journal.release, stageStat = lstatSync(item.stage); if (stageStat.dev !== currentItem.stageDev || stageStat.ino !== currentItem.stageIno) throw new Error('Release staging identity changed');
    owner(item.stage, 0, 0, 0o755, 'directory');
    for (const name of readdirSync(item.stage)) checked(host, '/usr/bin/rm', ['-rf', '--one-file-system', '--', join(item.stage, name)], 'Cannot reset bound release staging');
    for (const name of ['dist', 'node_modules', 'package.json', 'pnpm-lock.yaml']) checked(host, '/usr/bin/cp', ['-a', '--reflink=auto', join(source, name), join(item.stage, name)], `Cannot copy release ${name}`);
    checked(host, '/usr/bin/chown', ['-hR', 'root:root', item.stage], 'Cannot seal release ownership'); checked(host, '/usr/bin/chmod', ['-R', 'go-w', item.stage], 'Cannot seal release modes');
    const manifest = await createReleaseManifest(item.stage, spec.release.gitCommit); atomicExact(join(item.stage, 'RELEASE.json'), `${JSON.stringify(manifest, null, 2)}\n`, 0, 0, 0o444);
    syncPayloadTree(item.stage);
    journal = { ...journal, release: { ...journal.release, releaseId: manifest.releaseId, status: 'copied' } }; replaceJournal(journalPath, journal);
  }
  const releaseId = journal.release.releaseId;
  if (!releaseId) throw new Error('Copied release journal is missing its content identity');
  const final = join(managedLayout.releases, releaseId), staged = existsSync(item.stage) ? await verifyRelease(item.stage, releaseId) : undefined;
  if (journal.release.status === 'copied') {
    if (existsSync(final)) {
      const existing = await verifyRelease(final, releaseId); if (staged && existing.inventorySha256 !== staged.inventorySha256) throw new Error('Existing release identity differs');
      const finalIdentity = lstatSync(final); journal = { ...journal, release: { ...journal.release, stageDev: finalIdentity.dev, stageIno: finalIdentity.ino, status: 'published' } }; replaceJournal(journalPath, journal);
    } else { renameSync(item.stage, final); fsyncDirectory(managedLayout.releases); journal = { ...journal, release: { ...journal.release, status: 'published' } }; replaceJournal(journalPath, journal); }
  }
  if (journal.release.status === 'published' && existsSync(item.stage)) { await verifyRelease(item.stage, releaseId); checked(host, '/usr/bin/rm', ['-rf', '--one-file-system', '--', item.stage], 'Cannot remove duplicate release staging'); fsyncDirectory(managedLayout.releases); }
  return { journal, manifest: await verifyRelease(final), path: final };
}

function emptyMountpoint(root: string, uid: number, gid: number, expected?: { dev: number; ino: number }): void {
  if (!existsSync(dirname(root))) throw new Error(`Managed mount parent must already exist: ${dirname(root)}`);
  if (!existsSync(root)) { mkdirSync(root, { mode: 0o700 }); chownSync(root, uid, gid); chmodSync(root, 0o700); fsyncDirectory(dirname(root)); }
  const stat = lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Managed mountpoint is unsafe: ${root}`);
  if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino)) throw new Error(`Managed mountpoint identity changed: ${root}`);
  const visible = readdirSync(root).filter(name => name !== 'lost+found'); if (visible.length) throw new Error(`Managed mountpoint is not empty: ${root}`);
  if (stat.dev === lstatSync(dirname(root)).dev && (stat.uid !== uid || stat.gid !== gid || (stat.mode & 0o777) !== 0o700)) throw new Error(`Managed mountpoint underlay identity mismatch: ${root}`);
}

export function prepareMountpoint(host: InstallerHost, workspace: PlannedWorkspace, uid: number, gid: number, journalPath: string, journal: InstallJournal, index: number, creator = { uid: 0, gid: 0 }): InstallJournal {
  let record = journal.volumes[index]!;
  const mounted = mountedWorkspace(host, workspace.root);
  if (mounted !== undefined) {
    if (record.rootDev === undefined || record.rootIno === undefined) throw new Error(`Mounted workspace lacks a journal-bound underlay: ${workspace.root}`);
    assertMountedBacking(host, workspace, mounted); return journal;
  }
  const parent = lstatSync(dirname(workspace.root)), privateParent = dirname(workspace.root) === join(managedLayout.data, 'agents');
  const protectedOwner = parent.uid === 0 || (parent.uid === uid && (parent.mode & 0o077) === 0);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0 || !protectedOwner || (privateParent && parent.uid !== uid)) throw new Error(`Workspace mount parent is not protected: ${dirname(workspace.root)}`);
  if (record.rootDev === undefined || record.rootIno === undefined) {
    if (!pathExists(workspace.root)) { mkdirSync(workspace.root, { mode: 0o700 }); fsyncDirectory(dirname(workspace.root)); }
    const stat = lstatSync(workspace.root), recoverableCreatedRoot = !record.rootExisted && stat.uid === creator.uid && stat.gid === creator.gid && (stat.mode & 0o777) === 0o700;
    if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(workspace.root).length !== 0 || (record.rootExisted ? false : !recoverableCreatedRoot)) throw new Error(`Unbound workspace mountpoint is not the transaction-created empty directory: ${workspace.root}`);
    record = { ...record, rootDev: stat.dev, rootIno: stat.ino }; journal = { ...journal, volumes: journal.volumes.map((value, at) => at === index ? record : value) }; replaceJournal(journalPath, journal);
  }
  const expected = { dev: record.rootDev, ino: record.rootIno }; const stat = lstatSync(workspace.root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.dev || stat.ino !== expected.ino || readdirSync(workspace.root).length !== 0) throw new Error(`Journal-bound workspace mountpoint changed: ${workspace.root}`);
  chownSync(workspace.root, uid, gid); chmodSync(workspace.root, 0o700); fsyncDirectory(workspace.root); fsyncDirectory(dirname(workspace.root));
  return journal;
}

function assertMountedBacking(host: InstallerHost, workspace: PlannedWorkspace, output: string): void {
  const fields = output.trim().split(/\s+/), source = fields[0], filesystem = fields[1], options = new Set((fields[2] ?? '').split(','));
  if (!source || filesystem !== 'ext4' || !['rw', 'nodev', 'nosuid'].every(option => options.has(option))) throw new Error(`Existing workspace mount has unexpected filesystem or options: ${workspace.root}`);
  const loops = checked(host, '/usr/sbin/losetup', ['--associated', workspace.backingFile, '--noheadings', '--output', 'NAME'], 'Cannot inspect workspace loop device').split('\n').map(value => value.trim()).filter(Boolean);
  if (!loops.includes(source)) throw new Error(`Existing workspace mount does not use its managed backing: ${workspace.root}`);
}

function mountedWorkspace(host: InstallerHost, root: string): string | undefined {
  const result = host.run('/usr/bin/findmnt', ['--noheadings', '--mountpoint', root, '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS']);
  if (result.code !== 0) return undefined;
  const fields = result.stdout.trim().split(/\s+/);
  return fields[0] === root ? fields.slice(1).join(' ') : undefined;
}

export function initializePublishedVolume(host: InstallerHost, workspace: PlannedWorkspace, uid: number, gid: number, expectedMountpoint?: { dev: number; ino: number }): void {
  const mounted = mountedWorkspace(host, workspace.root);
  if (mounted !== undefined) assertMountedBacking(host, workspace, mounted);
  else { emptyMountpoint(workspace.root, uid, gid, expectedMountpoint); checked(host, '/usr/bin/mount', ['-o', 'loop,rw,nodev,nosuid', workspace.backingFile, workspace.root], 'Cannot initialize workspace mount'); }
  checked(host, '/usr/bin/chown', [`${uid}:${gid}`, workspace.root], 'Cannot set workspace owner');
  checked(host, '/usr/bin/chmod', ['0700', workspace.root], 'Cannot set workspace mode');
  fsyncDirectory(workspace.root);
  checked(host, '/usr/bin/umount', [workspace.root], 'Cannot unmount initialized workspace');
  emptyMountpoint(workspace.root, uid, gid, expectedMountpoint);
  fsyncFile(workspace.backingFile);
}

function prepareVolume(host: InstallerHost, workspace: PlannedWorkspace, uid: number, gid: number, journalPath: string, journal: InstallJournal, index: number): InstallJournal {
  let record = journal.volumes[index]!;
  if (record.status === 'planned') {
    if (!existsSync(record.stage)) {
      if (record.stageDev !== undefined) throw new Error('Recorded workspace staging file disappeared'); const fd = openSync(record.stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); closeSync(fd); fsyncDirectory(dirname(record.stage)); const created = lstatSync(record.stage);
      record = { ...record, stageDev: created.dev, stageIno: created.ino }; journal = { ...journal, volumes: journal.volumes.map((value, at) => at === index ? record : value) }; replaceJournal(journalPath, journal);
    } else if (record.stageDev === undefined) { owner(record.stage, 0, 0, 0o600, 'file'); const created = lstatSync(record.stage); record = { ...record, stageDev: created.dev, stageIno: created.ino }; journal = { ...journal, volumes: journal.volumes.map((value, at) => at === index ? record : value) }; replaceJournal(journalPath, journal); }
    const stageIdentity = lstatSync(record.stage); if (stageIdentity.dev !== record.stageDev || stageIdentity.ino !== record.stageIno) throw new Error('Workspace staging identity changed');
    owner(record.stage, 0, 0, 0o600, 'file');
    checked(host, '/usr/bin/truncate', ['--size', String(workspace.capacityBytes), record.stage], 'Cannot size workspace backing');
    checked(host, '/usr/sbin/mkfs.ext4', ['-q', '-F', record.stage], 'Cannot format workspace backing');
    checked(host, '/usr/bin/fallocate', ['--length', String(workspace.capacityBytes), record.stage], 'Cannot allocate workspace backing');
    const stat = lstatSync(record.stage); if (stat.size !== workspace.capacityBytes || stat.blocks * 512 < workspace.capacityBytes) throw new Error('Workspace backing allocation is incomplete');
    if (checked(host, '/usr/sbin/blkid', ['-p', '-s', 'TYPE', '-o', 'value', record.stage], 'Cannot inspect workspace filesystem') !== 'ext4') throw new Error('Workspace backing is not ext4');
    fsyncFile(record.stage);
    record = { ...record, status: 'formatted' }; journal = { ...journal, volumes: journal.volumes.map((value, at) => at === index ? record : value) }; replaceJournal(journalPath, journal);
  }
  if (record.status === 'formatted') {
    if (existsSync(workspace.backingFile)) { const final = lstatSync(workspace.backingFile), stage = existsSync(record.stage) ? lstatSync(record.stage) : undefined; if (!final.isFile() || final.isSymbolicLink() || final.uid !== 0 || final.gid !== 0 || (final.mode & 0o777) !== 0o600 || final.size !== workspace.capacityBytes || final.blocks * 512 < workspace.capacityBytes || final.dev !== record.stageDev || final.ino !== record.stageIno || (stage && (stage.dev !== final.dev || stage.ino !== final.ino))) throw new Error(`Existing backing differs: ${workspace.backingFile}`); if (stage) unlinkSync(record.stage); }
    else { renameSync(record.stage, workspace.backingFile); fsyncDirectory(managedLayout.volumes); }
    record = { ...record, status: 'published' }; journal = { ...journal, volumes: journal.volumes.map((value, at) => at === index ? record : value) }; replaceJournal(journalPath, journal);
  }
  if (record.status === 'published' || record.status === 'initialized') {
    const final = lstatSync(workspace.backingFile);
    if (!final.isFile() || final.isSymbolicLink() || final.uid !== 0 || final.gid !== 0 || (final.mode & 0o777) !== 0o600 || final.size !== workspace.capacityBytes || final.blocks * 512 < workspace.capacityBytes || final.dev !== record.stageDev || final.ino !== record.stageIno) throw new Error(`Published backing identity differs: ${workspace.backingFile}`);
    if (checked(host, '/usr/sbin/blkid', ['-p', '-s', 'TYPE', '-o', 'value', workspace.backingFile], 'Cannot inspect published workspace filesystem') !== 'ext4') throw new Error('Published workspace backing is not ext4');
  }
  if (record.status === 'published') {
    journal = prepareMountpoint(host, workspace, uid, gid, journalPath, journal, index); record = journal.volumes[index]!;
    initializePublishedVolume(host, workspace, uid, gid, { dev: record.rootDev!, ino: record.rootIno! });
    record = { ...record, status: 'initialized' }; journal = { ...journal, volumes: journal.volumes.map((value, at) => at === index ? record : value) }; replaceJournal(journalPath, journal);
  }
  return journal;
}

function mountUnits(host: InstallerHost, plan: DeploymentPlan): ManagedMount[] {
  return plan.workspaces.map(workspace => { const unitName = checked(host, '/usr/bin/systemd-escape', ['--path', '--suffix=mount', workspace.root], 'Cannot derive mount unit name'); assertSafeUnitName(unitName); return { root: workspace.root, backingFile: workspace.backingFile, unitName }; });
}

function workspaceManifest(plan: DeploymentPlan, uid: number, gid: number): string {
  return `${JSON.stringify({ version: 1, mounts: plan.workspaces.map(item => ({ kind: item.kind, ...(item.agentId ? { agentId: item.agentId } : {}), root: item.root, backingFile: item.backingFile, capacityBytes: item.capacityBytes, ownerUid: uid, ownerGid: gid })) }, null, 2)}\n`;
}

function publishCurrent(release: string): void {
  if (pathExists(managedLayout.current)) { const stat = lstatSync(managedLayout.current); if (!stat.isSymbolicLink() || realpathSync(managedLayout.current) !== release) throw new Error('Existing current release differs; upgrades belong to the V2d transaction'); return; }
  const temporary = join('/opt/mate', `.current.mate-${randomUUID()}`); symlinkSync(release, temporary); renameSync(temporary, managedLayout.current); fsyncDirectory('/opt/mate');
}

export async function installDeployment(spec: DeploymentSpec, config: DaemonConfig, host: InstallerHost = nodeInstallerHost()): Promise<{ plan: DeploymentPlan; releaseId: string; serviceStarted: false }> {
  if (host.euid() !== 0) throw new Error('Deployment installation must run as root');
  const plan = preflightDeployment(spec, config, host), identity = serviceIdentity(host), requestedIdentity = inputIdentity(spec, config, plan, host);
  if (pathExists(bootstrapJournalPath) && pathExists(controlJournalPath)) throw new Error('Both bootstrap and control install journals exist');
  let journalPath = pathExists(controlJournalPath) ? controlJournalPath : bootstrapJournalPath;
  let journal: InstallJournal;
  if (existsSync(journalPath)) { owner(journalPath, 0, 0, 0o600, 'file'); journal = journalSchema.parse(JSON.parse(readFileSync(journalPath, 'utf8'))); if (journal.inputIdentity !== requestedIdentity || journal.uid !== identity.uid || journal.gid !== identity.gid) throw new Error('An unfinished installation has a different identity'); }
  else {
    const transaction = randomUUID(), existing = host.existingInstall();
    if (existing) journalPath = controlJournalPath;
    if (existing && (!existing.complete || !existing.releaseId)) throw new Error('Unfinished installation journal disappeared before resume');
    const existingRelease = existing?.releaseId ? lstatSync(join(managedLayout.releases, existing.releaseId)) : undefined;
    journal = { version: 1, transaction, inputIdentity: requestedIdentity, ...identity, directories: layoutEntries(identity.uid, identity.gid),
      release: { stage: join(managedLayout.releases, `.mate-install-${transaction}-release`), ...(existingRelease ? { stageDev: existingRelease.dev, stageIno: existingRelease.ino, releaseId: existing!.releaseId } : {}), status: existing ? 'published' : 'planned' },
      volumes: plan.workspaces.map(item => { const final = existing ? lstatSync(item.backingFile) : undefined; return { backingFile: item.backingFile, stage: join(managedLayout.volumes, `.mate-install-${transaction}-${basename(item.backingFile)}`), ...(existing ? { root: item.root, rootExisted: true } : mountpointIntent(item.root)), ...(final ? { stageDev: final.dev, stageIno: final.ino } : {}), status: existing ? 'initialized' as const : 'planned' as const }; }), phase: existing ? 'published' : 'resources' }; replaceJournal(journalPath, journal);
  }
  journal = prepareLayout(journalPath, journal);
  if (journalPath === bootstrapJournalPath) { renameSync(bootstrapJournalPath, controlJournalPath); fsyncDirectory('/var/lib'); fsyncDirectory(dirname(controlJournalPath)); journalPath = controlJournalPath; }
  const published = await publishRelease(host, spec, journalPath, journal); journal = published.journal;
  for (let index = 0; index < plan.workspaces.length; index++) journal = prepareVolume(host, plan.workspaces[index]!, identity.uid, identity.gid, journalPath, journal, index);
  const units = mountUnits(host, plan), configText = `${JSON.stringify(config, null, 2)}\n`, envText = spec.environmentSource ? readFileSync(realpathSync(spec.environmentSource), 'utf8') : '';
  atomicExact(managedLayout.config, configText, 0, identity.gid, 0o640); atomicExact(managedLayout.environment, envText, 0, identity.gid, 0o640); atomicExact(managedLayout.manifest, workspaceManifest(plan, identity.uid, identity.gid), 0, identity.gid, 0o640);
  for (const unit of units) atomicExact(join('/etc/systemd/system', unit.unitName), renderMountUnit(unit), 0, 0, 0o644);
  atomicExact(managedLayout.service, renderService(units, spec.daemonMemoryMiB, plan.workspaces.filter(item => item.kind === 'external').map(item => item.root)), 0, 0, 0o644);
  atomicExact(managedLayout.wrapper, renderMaintenanceWrapper(plan.workspaces.filter(item => item.kind === 'external').map(item => item.root)), 0, 0, 0o755);
  journal = { ...journal, phase: 'units' }; replaceJournal(journalPath, journal);
  checked(host, '/usr/bin/systemctl', ['daemon-reload'], 'Cannot reload systemd'); for (const unit of units) checked(host, '/usr/bin/systemctl', ['enable', '--now', unit.unitName], `Cannot enable ${unit.unitName}`);
  journal = { ...journal, phase: 'mounted' }; replaceJournal(journalPath, journal);
  const entry = join(published.path, 'dist/src/main.js'), properties = ['--quiet', '--collect', '--wait', '--pipe', `--working-directory=${published.path}`, '--property=User=mate', '--property=Group=mate', '--property=SupplementaryGroups=docker', '--property=EnvironmentFile=/etc/mate/mate.env', '--property=UMask=0077', '--property=NoNewPrivileges=yes', '--property=PrivateTmp=yes', '--property=ProtectHome=yes', '--property=ProtectSystem=strict', '--property=ReadWritePaths=/var/lib/mate', ...plan.workspaces.filter(item => item.kind === 'external').map(item => `--property=ReadWritePaths=${item.root}`)];
  checked(host, '/usr/bin/systemd-run', [...properties, '/usr/bin/node', entry, 'doctor', managedLayout.config, '--allow-missing-secrets'], 'Candidate doctor failed');
  checked(host, '/usr/bin/systemd-run', [...properties, '/usr/bin/node', entry, 'offline-probe', managedLayout.config], 'Candidate offline probe failed');
  journal = { ...journal, phase: 'probed' }; replaceJournal(journalPath, journal);
  publishCurrent(published.path); checked(host, '/usr/bin/systemctl', ['disable', '--now', 'mate.service'], 'Cannot keep mate.service disabled after installation');
  journal = { ...journal, phase: 'published' }; replaceJournal(journalPath, journal); atomicExact(completedPath, `${JSON.stringify({ version: 1, inputIdentity: requestedIdentity, releaseId: published.manifest.releaseId }, null, 2)}\n`, 0, 0, 0o600); unlinkSync(journalPath); fsyncDirectory(dirname(journalPath));
  return { plan, releaseId: published.manifest.releaseId, serviceStarted: false };
}

export function disableDeployment(config: DaemonConfig, host: InstallerHost = nodeInstallerHost()): void {
  if (host.euid() !== 0) throw new Error('Deployment disable must run as root');
  checked(host, '/usr/bin/systemctl', ['disable', '--now', 'mate.service'], 'Cannot stop Mate service');
  checked(host, managedLayout.wrapper, ['offline-probe'], 'Cannot recover and verify the stopped execution scope');
  const manifest = JSON.parse(readFileSync(config.runtime.workspaceManifest!, 'utf8')) as { mounts: Array<{ root: string }> }, units = manifest.mounts.map(item => checked(host, '/usr/bin/systemd-escape', ['--path', '--suffix=mount', item.root], 'Cannot derive mount unit'));
  for (const unit of units.reverse()) checked(host, '/usr/bin/systemctl', ['disable', '--now', unit], `Cannot normally unmount ${unit}`);
}
