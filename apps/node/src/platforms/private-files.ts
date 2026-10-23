import { chmodSync } from "node:fs";
import type { PrivateFiles } from "./types.ts";

export const posixPrivateFiles: PrivateFiles = {
  directoryMode: 0o700,
  fileMode: 0o600,
  protectDirectory(path) {
    chmodSync(path, 0o700);
  },
  protectFile(path) {
    chmodSync(path, 0o600);
  },
  isPrivate(stat) {
    return (stat.mode & 0o077) === 0;
  },
};

export const windowsPrivateFiles: PrivateFiles = {
  directoryMode: undefined,
  fileMode: undefined,
  protectDirectory() {},
  protectFile() {},
  isPrivate() {
    return true;
  },
};
