import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const hashPattern = /^[a-f0-9]{64}$/;
const inventoryEntrySchema = z.discriminatedUnion('type', [
  z.object({ path: z.string().min(1), type: z.literal('file'), size: z.number().int().nonnegative(), mode: z.number().int().nonnegative(), sha256: z.string().regex(hashPattern) }).strict(),
  z.object({ path: z.string().min(1), type: z.literal('directory'), mode: z.number().int().nonnegative() }).strict(),
  z.object({ path: z.string().min(1), type: z.literal('symlink'), target: z.string().min(1) }).strict(),
]);
export const releaseManifestSchema = z.object({
  version: z.literal(1), releaseId: z.string().regex(hashPattern), gitCommit: z.string().regex(/^[a-f0-9]{7,64}$/),
  recoveryProtocol:z.number().int().positive(),
  target: z.object({ platform: z.literal('linux'), arch: z.literal('x64'), node: z.string().regex(/^v24\./), modulesAbi: z.string().regex(/^\d+$/), packageManager: z.literal('pnpm@10.33.0') }).strict(),
  lockSha256: z.string().regex(hashPattern), inventorySha256: z.string().regex(hashPattern), dependencyInventorySha256: z.string().regex(hashPattern),
  nativeAddons: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(hashPattern) }).strict()),
  inventory: z.array(inventoryEntrySchema),
}).strict();
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
type InventoryEntry = z.infer<typeof inventoryEntrySchema>;

export interface ReleaseRuntime {
  platform: NodeJS.Platform;
  arch: string;
  node: string;
  modulesAbi: string;
  packageManager: string;
}
export const currentReleaseRuntime = (): ReleaseRuntime => ({ platform: process.platform, arch: process.arch, node: process.version, modulesAbi: process.versions.modules, packageManager: 'pnpm@10.33.0' });

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((accept, reject) => { const stream = createReadStream(path); stream.on('data', chunk => hash.update(chunk)); stream.once('error', reject); stream.once('end', accept); });
  return hash.digest('hex');
}
function safeRelative(root: string, path: string): string {
  const value = relative(root, path);
  if (!value || value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value) || value.includes('\0')) throw new Error('Release inventory path escapes its root');
  return value.split(sep).join('/');
}

async function inventoryTree(root: string): Promise<InventoryEntry[]> {
  const entries: InventoryEntry[] = [], hardlinks = new Map<string, { expected: number; count: number; path: string }>();
  const visit = async (path: string): Promise<void> => {
    const stat = lstatSync(path), itemPath = safeRelative(root, path), mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (isAbsolute(target)) throw new Error(`Release symlink must be relative: ${itemPath}`);
      const destination = resolve(dirname(path), target);
      if (destination !== root && !destination.startsWith(`${root}${sep}`)) throw new Error(`Release symlink escapes its root: ${itemPath}`);
      entries.push({ path: itemPath, type: 'symlink', target }); return;
    }
    if (stat.isDirectory()) {
      entries.push({ path: itemPath, type: 'directory', mode });
      for (const name of readdirSync(path).sort()) await visit(join(path, name));
      return;
    }
    if (!stat.isFile()) throw new Error(`Release contains unsupported file: ${itemPath}`);
    const identity = `${stat.dev}:${stat.ino}`, links = hardlinks.get(identity);
    if (links) { if (links.expected !== stat.nlink) throw new Error(`Release hardlink identity changed: ${itemPath}`); links.count++; }
    else hardlinks.set(identity, { expected: stat.nlink, count: 1, path: itemPath });
    entries.push({ path: itemPath, type: 'file', size: stat.size, mode, sha256: await fileHash(path) });
  };
  for (const name of ['dist', 'node_modules', 'package.json', 'pnpm-lock.yaml']) {
    const path = join(root, name); if (!lstatSync(path)) throw new Error(`Missing release input: ${name}`); await visit(path);
  }
  for (const links of hardlinks.values()) if (links.count !== links.expected) throw new Error(`Release file has a hardlink outside the immutable tree: ${links.path}`);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function dependencyInventory(inventory: readonly InventoryEntry[]): string {
  return digest(stable(inventory.filter(item => item.path === 'node_modules' || item.path.startsWith('node_modules/'))));
}

export async function createReleaseManifest(rootPath: string, gitCommit: string, runtime: ReleaseRuntime = currentReleaseRuntime()): Promise<ReleaseManifest> {
  const root = realpathSync(rootPath);
  if (runtime.platform !== 'linux' || runtime.arch !== 'x64' || !/^v24\./.test(runtime.node) || runtime.packageManager !== 'pnpm@10.33.0') throw new Error('Release must be built on the supported Debian x86_64 Node 24 runtime with pnpm 10.33.0');
  if (!/^[a-f0-9]{7,64}$/.test(gitCommit)) throw new Error('Invalid source commit identity');
  const inventory = await inventoryTree(root), lock = inventory.find(item => item.path === 'pnpm-lock.yaml');
  if (!lock || lock.type !== 'file') throw new Error('Release lockfile is missing');
  const inventorySha256 = digest(stable(inventory)), base = {
    version: 1 as const, gitCommit, recoveryProtocol:1, target: { platform: 'linux' as const, arch: 'x64' as const, node: runtime.node, modulesAbi: runtime.modulesAbi, packageManager: 'pnpm@10.33.0' as const },
    lockSha256: lock.sha256, inventorySha256, dependencyInventorySha256: dependencyInventory(inventory),
    nativeAddons: inventory.filter((item): item is Extract<InventoryEntry, { type: 'file' }> => item.type === 'file' && item.path.endsWith('.node')).map(item => ({ path: item.path, sha256: item.sha256 })), inventory,
  };
  return releaseManifestSchema.parse({ ...base, releaseId: digest(stable(base)) });
}

export function assertReleaseRuntime(manifest:ReleaseManifest,runtime:ReleaseRuntime=currentReleaseRuntime()):void{
  const expected={platform:runtime.platform,arch:runtime.arch,node:runtime.node,modulesAbi:runtime.modulesAbi,packageManager:runtime.packageManager};
  if(stable(manifest.target)!==stable(expected))throw new Error('Release target does not match the current Node runtime and ABI');
}

/** Ownership sealing may change modes; the copied bytes and link targets may not change. */
export function assertSameReleasePayload(source:ReleaseManifest,copied:ReleaseManifest):void{
  const content=(manifest:ReleaseManifest)=>manifest.inventory.map(entry=>entry.type==='file'
    ?{path:entry.path,type:entry.type,size:entry.size,sha256:entry.sha256}
    :entry.type==='symlink'?{path:entry.path,type:entry.type,target:entry.target}
    :{path:entry.path,type:entry.type});
  if(source.gitCommit!==copied.gitCommit||stable(source.target)!==stable(copied.target)||stable(content(source))!==stable(content(copied)))throw new Error('Copied release payload differs from verified source');
}

export async function verifyRelease(rootPath: string, expectedId?: string, runtime:ReleaseRuntime|undefined=process.platform==='linux'?currentReleaseRuntime():undefined): Promise<ReleaseManifest> {
  const root = realpathSync(rootPath), stored = releaseManifestSchema.parse(JSON.parse(readFileSync(join(root, 'RELEASE.json'), 'utf8')));
  const recomputed = await createReleaseManifest(root, stored.gitCommit, stored.target);
  if (stable(recomputed) !== stable(stored) || (expectedId && stored.releaseId !== expectedId)) throw new Error('Release identity or inventory does not match immutable contents');
  if(runtime)assertReleaseRuntime(stored,runtime);
  return stored;
}
