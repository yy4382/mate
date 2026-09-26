import { closeSync, constants, openSync } from "node:fs";
import { flockSync } from "fs-ext";

/** Kernel-owned single-instance lock, released on service exit; its inode is never unlinked. */
export function acquireLock(path: string): () => void {
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    flockSync(fd, "exnb");
  } catch {
    closeSync(fd);
    throw new Error("Another Mate process holds the state directory lock");
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    flockSync(fd, "un");
    closeSync(fd);
  };
}
