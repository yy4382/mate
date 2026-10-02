import { spawnSync } from "node:child_process";
import { constants, closeSync, openSync } from "node:fs";
import { basename, dirname } from "node:path";

const pinnedPathPattern = /^\/proc\/self\/fd\/(\d+)\/([^/]+)$/;

/** Build a no-replace rename callback using the compiled OS primitive. There is no unsafe fallback. */
export function createAtomicNoReplaceRename(helperPath: string) {
  return (source: string, destination: string): void => {
    const sourceEntry = openEntry(source),
      destinationEntry = openEntry(destination);
    try {
      const result = spawnSync(helperPath, [sourceEntry.name, destinationEntry.name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", sourceEntry.directory, destinationEntry.directory],
        timeout: 5000,
      });
      if (result.error) throw new Error(`atomic_move_unavailable: ${result.error.message}`);
      if (result.status === 17)
        throw new Error("destination_exists: The move destination already exists");
      if (result.status !== 0)
        throw new Error(result.stderr.trim() || "atomic_move_failed: The move did not complete");
    } finally {
      if (sourceEntry.close) closeSync(sourceEntry.directory);
      if (destinationEntry.close) closeSync(destinationEntry.directory);
    }
  };
}

function openEntry(path: string): { directory: number; name: string; close: boolean } {
  const pinned = pinnedPathPattern.exec(path);
  if (pinned) return { directory: Number(pinned[1]), name: pinned[2]!, close: false };

  const name = basename(path);
  if (!name || name === "." || name === ".." || name.includes("\0"))
    throw new Error("unsafe_path: A move requires a single file name");
  return {
    directory: openSync(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    ),
    name,
    close: true,
  };
}
