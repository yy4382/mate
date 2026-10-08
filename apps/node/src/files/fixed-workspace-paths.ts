import { type Operation } from "@mate/protocol";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
} from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { systemErrorCode } from "../system-error.js";
import { FileOperationError } from "./file-failures.js";
import { within } from "./path-resolution.js";
// The CommonJS native binding is loaded only on Linux; its signature comes from @types/fs-ext.
type FlockSync = typeof import("fs-ext").flockSync;
const flockSync: FlockSync | undefined =
  process.platform === "linux"
    ? (createRequire(import.meta.url)("fs-ext").flockSync as FlockSync)
    : undefined;
const mutatingKinds = new Set<Operation["kind"]>([
  "write_bytes",
  "write",
  "edit",
  "mkdir",
  "move",
  "remove",
]);

/** Owns fixed directory descriptors, safe path traversal and the short mutation lock. */
export class FixedWorkspacePaths {
  readonly pinnedDirectoryPaths = process.platform === "linux" && existsSync("/proc/self/fd");
  private readonly rootDescriptor: number | undefined;
  private readonly pinnedDescriptors = new Set<number>();
  constructor(
    private readonly root: string,
    private readonly privateMode: boolean,
  ) {
    this.rootDescriptor = this.pinnedDirectoryPaths
      ? openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      : undefined;
    if (this.rootDescriptor !== undefined) {
      const rootStat = fstatSync(this.rootDescriptor);
      const pathStat = lstatSync(root);
      if (!rootStat.isDirectory() || rootStat.dev !== pathStat.dev || rootStat.ino !== pathStat.ino)
        throw new FileOperationError(
          "unsafe_path",
          "unsafe_path: Workspace root changed while it was opened",
        );
    }
  }
  lockMutation(kind: Operation["kind"]): void {
    // This lock serializes short Mate workspace mutations only; ordinary Agent shell commands do not
    // acquire it, so a long-lived command or background process cannot hold up this operation.
    if (
      this.pinnedDirectoryPaths &&
      this.rootDescriptor !== undefined &&
      flockSync !== undefined &&
      mutatingKinds.has(kind)
    )
      flockSync(this.rootDescriptor, "ex");
  }
  checked(
    path: string,
    {
      allowMissing = false,
      createParents = false,
    }: { allowMissing?: boolean; createParents?: boolean } = {},
  ): string {
    let workspacePath = path;
    if (isAbsolute(workspacePath)) {
      if (workspacePath === this.root) workspacePath = ".";
      else if (workspacePath.startsWith(`${this.root}/`))
        workspacePath = workspacePath.slice(this.root.length + 1);
      else throw new FileOperationError("unsafe_path", "unsafe_path: Path escapes the workspace");
    }
    if (workspacePath.includes("\0"))
      throw new FileOperationError("unsafe_path", "unsafe_path: Invalid workspace path");
    const parts = workspacePath.split("/").filter((part) => part !== "" && part !== ".");
    if (parts.some((part) => part === ".."))
      throw new FileOperationError("unsafe_path", "unsafe_path: Path escapes the workspace");
    if (this.pinnedDirectoryPaths && this.rootDescriptor !== undefined) {
      if (parts.length === 0) return `${descriptorPath(this.rootDescriptor)}/.`;
      let parent = this.rootDescriptor;
      let ownedParent = false;
      try {
        for (const part of parts.slice(0, -1)) {
          const candidate = `${descriptorPath(parent)}/${part}`;
          let child: number;
          try {
            child = openSync(
              candidate,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
          } catch (error) {
            if (!createParents || systemErrorCode(error) !== "ENOENT") throw error;
            try {
              mkdirSync(candidate, { mode: this.privateMode ? 0o700 : 0o755 });
            } catch (mkdirError) {
              if (systemErrorCode(mkdirError) !== "EEXIST") throw mkdirError;
            }
            child = openSync(
              candidate,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
          }
          if (ownedParent) closeSync(parent);
          parent = child;
          ownedParent = true;
        }
        const target = `${descriptorPath(parent)}/${parts.at(-1)!}`;
        try {
          if (lstatSync(target).isSymbolicLink())
            throw new FileOperationError(
              "unsafe_path",
              "unsafe_path: Symbolic links are not followed in the workspace",
            );
        } catch (error) {
          if (systemErrorCode(error) !== "ENOENT" || !allowMissing) throw error;
        }
        if (ownedParent) this.pinnedDescriptors.add(parent);
        return target;
      } catch (error) {
        if (ownedParent) closeSync(parent);
        throw error;
      }
    }
    let target = this.root;
    let missing = false;
    for (const part of parts) {
      target = resolve(target, part);
      if (!within(this.root, target))
        throw new FileOperationError("unsafe_path", "unsafe_path: Path escapes the workspace");
      if (missing) continue;
      try {
        if (lstatSync(target).isSymbolicLink())
          throw new FileOperationError(
            "unsafe_path",
            "unsafe_path: Symbolic links are not followed in the workspace",
          );
      } catch (error) {
        if (systemErrorCode(error) === "ENOENT" && allowMissing) missing = true;
        else throw error;
      }
    }
    return target;
  }

  releasePinned(path: string): void {
    if (!this.pinnedDirectoryPaths || this.rootDescriptor === undefined) return;
    const match = path.match(/^\/proc\/self\/fd\/(\d+)(?:\/|$)/);
    const descriptor = match ? Number(match[1]) : undefined;
    if (
      descriptor !== undefined &&
      descriptor !== this.rootDescriptor &&
      this.pinnedDescriptors.delete(descriptor)
    )
      closeSync(descriptor);
  }

  directoryNames(path: string): string[] {
    if (!this.pinnedDirectoryPaths) return readdirSync(path);
    const before = lstatSync(path);
    if (!before.isDirectory() || before.isSymbolicLink())
      throw new FileOperationError(
        "unsafe_path",
        "unsafe_path: A real workspace directory is required",
      );
    const descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino)
        throw new FileOperationError(
          "unsafe_path",
          "unsafe_path: Workspace directory changed while it was opened",
        );
      return readdirSync(descriptorPath(descriptor));
    } finally {
      closeSync(descriptor);
    }
  }
}
function descriptorPath(descriptor: number): string {
  return `/proc/self/fd/${descriptor}`;
}
