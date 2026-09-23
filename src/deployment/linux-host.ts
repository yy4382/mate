import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync, statfsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { daemonConfigSchema, type DaemonConfig } from '../daemon/config.js';
import { deploymentSpecSchema, type DeploymentSpec } from './spec.js';

export interface LinuxInstallerHost {
  platform: NodeJS.Platform;
  arch: string;
  node: string;
  euid(): number;
  read(path: string): string;
  assertRootExecutable(path: string): void;
  run(binary: string, args: readonly string[]): { code: number; stdout: string; stderr: string };
  directoryBytes(path: string): number;
  canonical(path: string): string;
  availableBytes(path: string): number;
  memoryMiB(): number;
}

function run(binary: string, args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(binary, [...args], { encoding: 'utf8', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' }, maxBuffer: 4 * 1024 * 1024 });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? String(result.error ?? '') };
}
function directoryBytes(path: string): number {
  let total = 0;
  const visit = (current: string): void => { const stat = lstatSync(current); if (stat.isFile()) total += stat.blocks * 512; else if (stat.isDirectory()) for (const name of readdirSync(current)) visit(join(current, name)); };
  visit(path); return total;
}
function canonical(path: string): string {
  const tail: string[] = []; let current = resolve(path);
  while (true) {
    try { lstatSync(current); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = dirname(current); if (parent === current) throw new Error(`Cannot resolve deployment path: ${path}`); tail.unshift(basename(current)); current = parent; }
  }
  return resolve(realpathSync(current), ...tail);
}
export const nodeLinuxInstallerHost = (): LinuxInstallerHost => ({
  platform: process.platform, arch: process.arch, node: process.version, euid: () => process.geteuid?.() ?? -1,
  read: path => readFileSync(path, 'utf8'), run, directoryBytes, canonical,
  assertRootExecutable: path => { const link = lstatSync(path), stat = lstatSync(realpathSync(path)); if ((!link.isFile() && !link.isSymbolicLink()) || link.uid !== 0 || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0) throw new Error(`Host executable is not protected: ${path}`); },
  availableBytes: path => { const stat = statfsSync(path); return Number(BigInt(stat.bavail) * BigInt(stat.bsize)); },
  memoryMiB: () => { const match = /^MemTotal:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8')); if (!match) throw new Error('Cannot read host memory'); return Math.floor(Number(match[1]) / 1024); },
});
export function readLinuxDeploymentInputs(path: string): { spec: DeploymentSpec; config: DaemonConfig } {
  const spec = deploymentSpecSchema.parse(JSON.parse(readFileSync(realpathSync(path), 'utf8')));
  const config = daemonConfigSchema.parse(JSON.parse(readFileSync(realpathSync(spec.configSource), 'utf8')));
  return { spec, config };
}
