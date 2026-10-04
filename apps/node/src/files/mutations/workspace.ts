import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { FileOperationError } from "../file-failures.js";

/** Moves a regular file through an OS atomic no-replace rename primitive. */
export function moveFileNoReplace(
  source: string,
  destination: string,
  renameNoReplace: (source: string, destination: string) => void,
  beforeRename?: () => void,
): void {
  const original = lstatSync(source);
  if (!original.isFile() || original.isSymbolicLink())
    throw new FileOperationError("not_file", "not_file: Only regular files can be moved safely");
  const immediatelyBeforeRename = lstatSync(source);
  if (
    !immediatelyBeforeRename.isFile() ||
    immediatelyBeforeRename.dev !== original.dev ||
    immediatelyBeforeRename.ino !== original.ino
  )
    throw new FileOperationError(
      "file_changed",
      "file_changed: A file changed while it was being moved",
    );
  beforeRename?.();
  renameNoReplace(source, destination);
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
    throw new FileOperationError(
      "file_changed",
      "file_changed: File changed before the edit could be committed",
    );
  commit();
}
