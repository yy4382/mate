import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentPlatform } from "./platforms/index.ts";

/** What `node run` records about its link to the gateway, for `mate node status` to report. */
export type LinkState = {
  pid: number;
  connected: boolean;
  /** ISO time the link last changed. */
  since: string;
};

const FILE = "link.json";

/** Replace the link file whole, so a reader never sees half of one. */
export function writeLink(dataDirectory: string, connected: boolean): void {
  const privateFiles = currentPlatform().privateFiles;
  mkdirSync(dataDirectory, { recursive: true, mode: privateFiles.directoryMode });
  privateFiles.protectDirectory(dataDirectory);
  const state: LinkState = { pid: process.pid, connected, since: new Date().toISOString() };
  const path = join(dataDirectory, FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: privateFiles.fileMode });
  privateFiles.protectFile(temporary);
  renameSync(temporary, path);
}

/** The recorded link, or undefined when there is none or it is unreadable. */
export function readLink(dataDirectory: string): LinkState | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDirectory, FILE), "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const { pid, connected, since } = value as Record<string, unknown>;
    if (
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof connected !== "boolean" ||
      typeof since !== "string" ||
      !Number.isFinite(Date.parse(since))
    ) {
      return undefined;
    }
    return { pid, connected, since };
  } catch {
    return undefined;
  }
}
