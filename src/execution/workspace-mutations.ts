import { linkSync, lstatSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";

/** Atomically claims a regular-file destination without replacing an entry created concurrently. */
export function moveFileNoReplace(
  source: string,
  destination: string,
  beforeClaim?: () => void,
): void {
  const original = lstatSync(source);
  if (!original.isFile() || original.isSymbolicLink())
    throw new Error("not_file: Only regular files can be moved safely");
  beforeClaim?.();
  try {
    linkSync(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("destination_exists: The move destination already exists");
    throw error;
  }

  const sourceAfterClaim = lstatSync(source),
    destinationAfterClaim = lstatSync(destination);
  if (
    sourceAfterClaim.dev !== original.dev ||
    sourceAfterClaim.ino !== original.ino ||
    destinationAfterClaim.dev !== original.dev ||
    destinationAfterClaim.ino !== original.ino
  )
    throw new Error("file_changed: A file changed while it was being moved");
  unlinkSync(source);
}

/** Rechecks an edit's expected content immediately before its atomic rename.
 * Mate workspace mutations share a short advisory lock; uncoordinated same-UID writers can still
 * race the final check and rename, so this is not a filesystem compare-and-swap operation.
 */
export function commitFileIfHashMatches(
  expectedHash: string,
  readCurrent: () => Uint8Array,
  commit: () => void,
  beforeFinalCheck?: () => void,
): void {
  beforeFinalCheck?.();
  const actualHash = createHash("sha256").update(readCurrent()).digest("hex");
  if (actualHash !== expectedHash)
    throw new Error("file_changed: File changed before the edit could be committed");
  commit();
}
