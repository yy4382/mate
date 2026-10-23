import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { WorkspacePaths } from "./types.ts";

export const posixWorkspacePaths: WorkspacePaths = {
  async accepts(root, _input, resolved) {
    const real = await realExistingPrefix(resolved);
    return real !== undefined && inside(root, resolved) && inside(root, real);
  },
};

export const windowsWorkspacePaths: WorkspacePaths = {
  async accepts(root, input, resolved) {
    const segments = input.split(/[\\/]/);
    if (segments.includes("..")) return false;
    if (segments.some((segment) => segment !== "." && /[. ]$/.test(segment))) return false;
    if (segments.some((segment) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)))
      return false;
    if (
      segments.some(
        (segment, index) => segment.includes(":") && !(index === 0 && /^[a-z]:$/i.test(segment)),
      )
    )
      return false;
    if (input.startsWith("\\\\") || input.startsWith("//")) return false;
    if (/^[a-z]:(?![\\/])/i.test(input)) return false;
    if (/^[\\/](?![\\/])/.test(input)) return false;
    if (!insideWindows(root, resolved)) return false;

    const rest = win32.relative(root, resolved);
    let current = root;
    for (const segment of ["", ...rest.split(win32.sep).filter(Boolean)]) {
      current = win32.join(current, segment);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        return false;
      }
    }
    const real = await realExistingPrefix(resolved);
    return real !== undefined && insideWindows(root, real);
  },
};

function inside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

function insideWindows(root: string, path: string): boolean {
  const rest = win32.relative(root, path);
  return rest !== ".." && !rest.startsWith("..\\") && !win32.isAbsolute(rest);
}

async function realExistingPrefix(path: string): Promise<string | undefined> {
  for (let current = resolve(path); ; current = dirname(current)) {
    const exists = await lstat(current).then(
      () => true,
      () => false,
    );
    if (exists) return realpath(current).catch(() => undefined);
    if (dirname(current) === current) return undefined;
  }
}
