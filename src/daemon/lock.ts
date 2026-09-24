import { openSync, closeSync, constants } from "node:fs";
import { flockSync } from "fs-ext";
/** Kernel-owned lock: no stale-PID removal race, released on daemon crash. Never unlink its inode. */
export function acquireLock(path: string): () => void {
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    flockSync(fd, "exnb");
  } catch {
    closeSync(fd);
    throw new Error("Another Mate daemon holds the data directory lock");
  }
  let released = false;
  return () => {
    if (!released) {
      released = true;
      flockSync(fd, "un");
      closeSync(fd);
    }
  };
}
