import { lstatSync, readdirSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { lstatIfPresent, nodePaths } from "./paths.js";
import {
  readBundle,
  verifyBundle,
  probeBundle,
  runningBundleDirectory,
  type BundleMetadata,
} from "./bundle.js";
import { checkManagedDirectory } from "./install-entry.js";
import { createAtomicNoReplaceRename } from "../files/mutations/atomic-rename.js";

/** A trusted unchanged inventory identifies damaged owned program files, never arbitrary extra files. */
function assertRepairOwnership(directory: string, metadata: BundleMetadata) {
  checkManagedDirectory(directory);
  const manifest = lstatSync(join(directory, "bundle.json"));
  if (
    !manifest.isFile() ||
    manifest.uid !== process.getuid?.() ||
    JSON.stringify(readBundle(directory)) !== JSON.stringify(metadata)
  )
    throw new Error(
      "Same-version repair requires the original inventory matching the verified local complete bundle",
    );
  const files = new Set(["bundle.json", ...metadata.files.map((file) => file.path)]);
  const directories = new Set<string>();
  for (const file of metadata.files) {
    let parent = dirname(file.path);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  const visit = (relative: string) => {
    for (const name of readdirSync(join(directory, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      const info = lstatSync(join(directory, path));
      if (
        info.uid !== process.getuid?.() ||
        (!info.isDirectory() && !info.isFile()) ||
        (info.isDirectory() ? !directories.has(path) : !files.has(path))
      )
        throw new Error(
          `Unknown file or ownership conflict preserved during bundle repair: ${join(directory, path)}`,
        );
      if (info.isDirectory()) visit(path);
    }
  };
  visit("");
}

/** Called after new-package preflight and while locked. An external CLI remains available during repair. */
export function prepareSameVersionRepair(
  paths: ReturnType<typeof nodePaths>,
  metadata: BundleMetadata,
) {
  const backups = lstatIfPresent(paths.versionsDirectory)
    ? readdirSync(paths.versionsDirectory)
        .filter((name) =>
          /^\.repair-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name),
        )
        .map((name) => join(paths.versionsDirectory, name))
    : [];
  const remaining = backups.filter((directory) => {
    checkManagedDirectory(directory);
    if (readdirSync(directory).length === 0) {
      rmdirSync(directory);
      return false;
    }
    assertRepairOwnership(directory, metadata);
    return true;
  });
  const destination = join(paths.versionsDirectory, metadata.version);
  if (!lstatIfPresent(destination)) return remaining;
  checkManagedDirectory(destination);
  // Another release payload under this version is a conflict, not a request to overwrite it.
  const manifest = lstatSync(join(destination, "bundle.json"));
  if (
    !manifest.isFile() ||
    manifest.uid !== process.getuid?.() ||
    JSON.stringify(readBundle(destination)) !== JSON.stringify(metadata)
  )
    throw new Error("Same-version bundle inventory differs; do not overwrite it");
  try {
    const installed = verifyBundle(destination, metadata.version);
    probeBundle(destination, installed);
    return remaining;
  } catch {
    if (resolve(runningBundleDirectory()) === realpathSync(destination))
      throw new Error(
        "Installed same-version package is damaged. Run the update command with a verified local bundle's dedicated Node and CLI; the executing package must remain available",
      );
  }
  assertRepairOwnership(destination, metadata);
  const backup = join(paths.versionsDirectory, `.repair-${randomUUID()}`);
  createAtomicNoReplaceRename(
    join(runningBundleDirectory(), "app/apps/node/dist/files/rename-noreplace"),
  )(destination, backup);
  assertRepairOwnership(backup, metadata);
  return [...remaining, backup];
}

export function finishSameVersionRepair(backups: string[], metadata: BundleMetadata) {
  for (const directory of backups) {
    assertRepairOwnership(directory, metadata);
    // Keep the inventory until every listed payload and empty directory has gone, so SIGKILL is retryable.
    const directories = new Set<string>();
    for (const file of metadata.files) {
      rmSync(join(directory, file.path), { force: true });
      let parent = dirname(file.path);
      while (parent !== ".") {
        directories.add(parent);
        parent = dirname(parent);
      }
    }
    for (const path of [...directories].sort((a, b) => b.split("/").length - a.split("/").length))
      if (lstatIfPresent(join(directory, path))) rmdirSync(join(directory, path));
    rmSync(join(directory, "bundle.json"));
    rmdirSync(directory);
  }
}
