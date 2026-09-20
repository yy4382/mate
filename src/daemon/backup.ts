import { cp, mkdir, readdir, lstat, writeFile, realpath } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { within } from '../execution/paths.js';
import type { Store } from '../storage/store.js';
/** Caller stops scheduling and waits for workers/executors to settle before taking this checkpoint. */
export async function backup(store: Store, dataDir: string, destination: string): Promise<void> {
  if (within(await realpath(dataDir), join(await realpath(dirname(resolve(destination))), basename(destination)))) throw new Error('Backup destination must be outside live data directory');
  if (store.db.prepare("SELECT 1 FROM runs WHERE state='active'").get() || store.db.prepare("SELECT 1 FROM actions WHERE state='executing'").get()) throw new Error('Backup requires idle workers and executors');
  const ensureTree = async (path: string): Promise<void> => { for (const name of await readdir(path)) { const file = join(path, name), stat = await lstat(file); if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) throw new Error('Backup memory contains unsupported file'); if (stat.isDirectory()) await ensureTree(file); } };
  await ensureTree(join(dataDir, 'agents'));
  await mkdir(destination, { mode: 0o700 });
  await store.backup(join(destination, 'mate.sqlite'));
  await cp(join(dataDir, 'agents'), join(destination, 'agents'), { recursive: true, errorOnExist: true, force: false });
  await writeFile(join(destination, 'COMPLETE.json'), JSON.stringify({ version: 1, dataDir: resolve(dataDir), at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
}
