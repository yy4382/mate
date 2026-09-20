import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
export function within(root: string, path: string): boolean {
  const rel = relative(root, path); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
export function canonicalRoot(root: string, forbidden: string[]): string {
  const canonical = realpathSync(root);
  if (!lstatSync(canonical).isDirectory()) throw new Error('Root is not a directory');
  for (const item of forbidden) {
    let protectedPath = resolve(item);
    try { protectedPath = realpathSync(protectedPath); } catch { /* protected paths may not yet exist */ }
    if (within(canonical, protectedPath) || within(protectedPath, canonical)) throw new Error('Protected root overlap');
  }
  return canonical;
}
/** Reject symlink traversal even when it points back inside the grant. OS sandbox remains the race boundary. */
export function checkedPath(root: string, path: string): string {
  if (isAbsolute(path) || path.includes('\0')) throw new Error('Relative path required');
  const full = resolve(root, path); if (!within(root, full)) throw new Error('Path escapes root');
  let current = root;
  for (const piece of relative(root, full).split(sep).filter(Boolean)) {
    current = resolve(current, piece);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Symlinks are not allowed'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return full;
}
