import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { WorkspacePaths } from "./types.ts";

export const posixWorkspacePaths: WorkspacePaths = {
  async resolve(root, _input, resolved) {
    const real = await realExistingPrefix(resolved);
    return real !== undefined && inside(root, resolved) && inside(root, real)
      ? resolved
      : undefined;
  },
};

export const windowsWorkspacePaths: WorkspacePaths = {
  async resolve(root, input, resolved) {
    const segments = input.split(/[\\/]/);
    if (segments.includes("..")) return undefined;
    if (segments.some((segment) => segment !== "." && /[. ]$/.test(segment))) return undefined;
    if (segments.some((segment) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)))
      return undefined;
    if (
      segments.some(
        (segment, index) => segment.includes(":") && !(index === 0 && /^[a-z]:$/i.test(segment)),
      )
    )
      return undefined;
    if (input.startsWith("\\\\") || input.startsWith("//")) return undefined;
    if (/^[a-z]:(?![\\/])/i.test(input)) return undefined;
    if (/^[\\/](?![\\/])/.test(input)) return undefined;

    const canonicalRoot = await realpath(root).catch(() => undefined);
    const canonical = await windowsPathWithoutLinks(resolved);
    return canonicalRoot !== undefined &&
      canonical !== undefined &&
      insideWindows(canonicalRoot, canonical)
      ? canonical
      : undefined;
  },
};

async function windowsPathWithoutLinks(path: string): Promise<string | undefined> {
  const root = win32.parse(path).root;
  const segments = path.slice(root.length).split(win32.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    const next = win32.join(current, segments[index]!);
    try {
      const stat = await lstat(next);
      if (stat.isSymbolicLink()) return undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      const existing = await realpath(current).catch(() => undefined);
      return existing === undefined ? undefined : win32.join(existing, ...segments.slice(index));
    }
    current = next;
  }
  return realpath(current).catch(() => undefined);
}

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
