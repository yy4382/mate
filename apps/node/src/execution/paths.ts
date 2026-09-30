import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
export function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
export function canonicalRoot(root: string, forbidden: string[]): string {
  const canonical = realpathSync(root);
  if (!lstatSync(canonical).isDirectory()) throw new Error("Root is not a directory");
  for (const item of forbidden) {
    let protectedPath = resolve(item);
    try {
      protectedPath = realpathSync(protectedPath);
    } catch {
      /* protected paths may not yet exist */
    }
    if (within(canonical, protectedPath) || within(protectedPath, canonical))
      throw new Error("Protected root overlap");
  }
  return canonical;
}
