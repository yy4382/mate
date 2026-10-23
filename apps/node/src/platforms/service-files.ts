import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Ownership } from "./types.ts";

export function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function markedFileOwnership(path: string, marker: string): Ownership {
  const stat = lstatOrUndefined(path);
  if (stat === undefined) return "absent";
  if (!stat.isFile()) return "foreign";
  return readFileSync(path, "utf8").includes(marker) ? "mate" : "foreign";
}

export function writeServiceFile(path: string, content: string): boolean {
  if (lstatOrUndefined(path) !== undefined && readFileSync(path, "utf8") === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.mate-tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
  return true;
}

export function xmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function fileLogs(path: string, lines: number, follow: boolean): number {
  if (lstatOrUndefined(path) === undefined) {
    process.stdout.write(`No node log exists yet (${path}).\n`);
    return 0;
  }
  const result = spawnSync("tail", ["-n", String(lines), ...(follow ? ["-f"] : []), path], {
    stdio: "inherit",
  });
  if (result.error !== undefined) throw new Error(`tail failed: ${result.error.message}`);
  return result.status ?? 1;
}

export function reportToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}
