import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import type { WorkspacePaths } from "./types.ts";

export const posixWorkspacePaths: WorkspacePaths = {
  async resolve(root, _configuredRoot, _input, resolved) {
    const real = await realExistingPrefix(resolved);
    return real !== undefined && inside(root, resolved) && inside(root, real)
      ? resolved
      : undefined;
  },
};

export const windowsWorkspacePaths: WorkspacePaths = {
  async resolve(root, configuredRoot, input, resolved) {
    const segments = input.split(/[\\/]/);
    if (segments.includes("..")) return undefined;
    if (input.startsWith("\\\\") || input.startsWith("//")) return undefined;
    if (/^[a-z]:(?![\\/])/i.test(input)) return undefined;
    if (/^[\\/](?![\\/])/.test(input)) return undefined;

    if (!insideWindows(root, resolved)) {
      if (!insideWindows(configuredRoot, resolved)) return undefined;
      resolved = win32.join(root, win32.relative(configuredRoot, resolved));
    }
    return windowsPathWithoutLinks(root, resolved);
  },
};

async function windowsPathWithoutLinks(root: string, path: string): Promise<string | undefined> {
  const segments = win32.relative(root, path).split(win32.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    const next = win32.join(current, segments[index]!);
    try {
      const stat = await lstat(next);
      if (stat.isSymbolicLink()) return undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      return win32.join(current, ...segments.slice(index));
    }
    current = await realpath(next);
    if (!insideWindows(root, current)) return undefined;
  }
  return current;
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
