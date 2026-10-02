import {
  constants,
  accessSync,
  closeSync,
  fstatSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import locks from "fs-ext";
import { nodePaths } from "./paths.js";
import {
  bundleEntrypoints,
  probeBundle,
  readBundle,
  releaseVersion,
  runningBundleDirectory,
  type BundleMetadata,
  verifyBundle,
} from "./bundle.js";
import { createAtomicNoReplaceRename } from "../files/atomic-rename.js";

export function requireOrdinaryAccount() {
  if (process.getuid?.() === 0)
    throw new Error("Mate must run as the existing ordinary account, never root");
}

export function checkManagedDirectory(path: string) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.())
    throw new Error(`Not an account-owned directory: ${path}`);
  accessSync(path, constants.W_OK | constants.X_OK);
}

export function prepareManagedDirectory(path: string) {
  if (!existsSync(path)) {
    prepareManagedDirectory(dirname(path));
    mkdirSync(path, { mode: 0o700 });
  }
  checkManagedDirectory(path);
}

export function preflightDirectory(path: string): void {
  if (existsSync(path)) checkManagedDirectory(path);
  else preflightDirectory(dirname(path));
}

export async function withManagementLock<T>(paths: ReturnType<typeof nodePaths>, action: () => T) {
  prepareManagedDirectory(paths.programDirectory);
  const fd = openSync(
    join(paths.programDirectory, "management.lock"),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    locks.flockSync(fd, "exnb");
    return await action();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EAGAIN")
      throw new Error("Another Mate management command is running; retry after it finishes");
    throw error;
  } finally {
    closeSync(fd);
  }
}

export function installedEntryVersion(paths: ReturnType<typeof nodePaths>) {
  if (!existsSync(paths.entry) && !lstatIfPresent(paths.entry)) return undefined;
  const info = lstatSync(paths.entry);
  if (!info.isSymbolicLink() || info.uid !== process.getuid?.())
    throw new Error(`Non-Mate file conflicts with management entry: ${paths.entry}`);
  const target = readlinkSync(paths.entry);
  const prefix = `${paths.versionsDirectory}/`;
  if (!target.startsWith(prefix) || !target.endsWith("/bin/mate"))
    throw new Error(`Non-Mate link conflicts with management entry: ${paths.entry}`);
  const version = target.slice(prefix.length, -"/bin/mate".length);
  if (!releaseVersion.safeParse(version).success)
    throw new Error("Invalid installed Mate entry target");
  return version;
}

export function lstatIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

const installationStageMarker = "Mate node bootstrap staging\n";
const temporaryId = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";

function assertPartialInstallation(stage: string, verifiedDirectory: string) {
  const metadata = readBundle(verifiedDirectory),
    files = new Set(["bundle.json", ...metadata.files.map((file) => file.path)]),
    directories = new Set<string>();
  const left = Buffer.allocUnsafe(64 * 1024),
    right = Buffer.allocUnsafe(64 * 1024);
  for (const file of files) {
    let parent = dirname(file);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  const visit = (part: string) => {
    checkManagedDirectory(join(stage, part));
    for (const name of readdirSync(join(stage, part))) {
      const path = part ? `${part}/${name}` : name,
        absolute = join(stage, path),
        info = lstatSync(absolute);
      if (path === ".mate-install-stage") {
        if (
          !info.isFile() ||
          info.uid !== process.getuid?.() ||
          readFileSync(absolute, "utf8") !== installationStageMarker
        )
          throw new Error(`Unknown interrupted installation marker preserved: ${absolute}`);
        continue;
      }
      if (info.isDirectory() && directories.has(path)) {
        visit(path);
        continue;
      }
      if (!files.has(path) || !info.isFile() || info.uid !== process.getuid?.())
        throw new Error(`Unknown interrupted installation object preserved: ${absolute}`);
      const staged = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const original = openSync(
          join(verifiedDirectory, path),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const copied = fstatSync(staged),
            source = fstatSync(original);
          if (
            !copied.isFile() ||
            copied.uid !== process.getuid?.() ||
            !source.isFile() ||
            source.uid !== process.getuid?.() ||
            copied.size > source.size
          )
            throw new Error(`Unknown interrupted installation file preserved: ${absolute}`);
          for (let position = 0; position < copied.size;) {
            const length = Math.min(left.length, copied.size - position);
            if (
              readSync(staged, left, 0, length, position) !== length ||
              readSync(original, right, 0, length, position) !== length ||
              !left.subarray(0, length).equals(right.subarray(0, length))
            )
              throw new Error(
                `Unknown interrupted installation contents preserved: ${absolute}; retry with the original version's verified local complete bundle`,
              );
            position += length;
          }
        } finally {
          closeSync(original);
        }
      } finally {
        closeSync(staged);
      }
    }
  };
  visit("");
}

export function recoverInstallationStaging(
  paths: ReturnType<typeof nodePaths>,
  verifiedDirectory: string,
) {
  if (existsSync(paths.versionsDirectory)) {
    for (const name of readdirSync(paths.versionsDirectory)) {
      if (!new RegExp(`^\\.install-${temporaryId}$`).test(name)) continue;
      const stage = join(paths.versionsDirectory, name);
      checkManagedDirectory(stage);
      const marker = join(stage, ".mate-install-stage");
      const info = lstatIfPresent(marker);
      const names = readdirSync(stage);
      const markerContents =
        info?.isFile() && info.uid === process.getuid?.()
          ? readFileSync(marker, "utf8")
          : undefined;
      if (
        names.length === 0 ||
        (names.length === 1 &&
          names[0] === ".mate-install-stage" &&
          markerContents !== undefined &&
          installationStageMarker.startsWith(markerContents))
      ) {
        rmSync(stage, { recursive: true });
        continue;
      }
      if (info && markerContents !== installationStageMarker)
        throw new Error(`Unknown interrupted installation marker preserved: ${marker}`);
      if (markerContents === installationStageMarker) {
        assertPartialInstallation(stage, verifiedDirectory);
        rmSync(stage, { recursive: true });
        continue;
      }
      // The marker is removed only after the full copy; a complete inventory proves ownership.
      try {
        assertPartialInstallation(stage, verifiedDirectory);
        if (JSON.stringify(verifyBundle(stage)) !== JSON.stringify(readBundle(verifiedDirectory)))
          throw new Error("Interrupted stage inventory differs from the verified source");
      } catch {
        throw new Error(`Unrecognized interrupted installation directory: ${stage}`);
      }
      rmSync(stage, { recursive: true });
    }
  }
  if (!existsSync(dirname(paths.entry))) return;
  for (const name of readdirSync(dirname(paths.entry))) {
    if (!new RegExp(`^\\.mate-(entry|previous)-${temporaryId}$`).test(name)) continue;
    const path = join(dirname(paths.entry), name);
    const info = lstatSync(path);
    if (!info.isSymbolicLink() || info.uid !== process.getuid?.())
      throw new Error(
        `An interrupted entry change preserved an unknown file at ${path}; restore it before retrying`,
      );
    const target = readlinkSync(path);
    const prefix = `${paths.versionsDirectory}/`;
    if (!target.startsWith(prefix) || !target.endsWith("/bin/mate"))
      throw new Error(`Unknown interrupted entry link was preserved at ${path}`);
    const version = target.slice(prefix.length, -"/bin/mate".length);
    verifyBundle(join(paths.versionsDirectory, version), version);
    rmSync(path);
  }
}

export function publishManagementEntry(
  paths: ReturnType<typeof nodePaths>,
  version: string,
  oldVersion: string | undefined,
) {
  if (oldVersion === version) return;
  const noReplace = createAtomicNoReplaceRename(
    join(runningBundleDirectory(), "app/apps/node/dist/files/rename-noreplace"),
  );
  const temporaryEntry = join(dirname(paths.entry), `.mate-entry-${randomUUID()}`);
  const previousEntry = join(dirname(paths.entry), `.mate-previous-${randomUUID()}`);
  let previousMoved = false;
  try {
    symlinkSync(join(paths.versionsDirectory, version, "bin/mate"), temporaryEntry);
    if (oldVersion !== undefined) {
      // Move first, then inspect the actual object. Never delete a file based on an earlier check.
      noReplace(paths.entry, previousEntry);
      previousMoved = true;
      const info = lstatSync(previousEntry);
      if (
        !info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        readlinkSync(previousEntry) !== join(paths.versionsDirectory, oldVersion, "bin/mate")
      )
        throw new Error(
          "Management entry changed concurrently; the conflicting file was preserved",
        );
    }
    noReplace(temporaryEntry, paths.entry);
    if (previousMoved) {
      rmSync(previousEntry);
      previousMoved = false;
    }
  } catch (error) {
    if (previousMoved) {
      try {
        noReplace(previousEntry, paths.entry);
        previousMoved = false;
      } catch {
        throw new Error(
          `Entry change failed; the original file is preserved at ${previousEntry}. Resolve the current entry conflict before retrying.`,
        );
      }
    }
    throw error;
  } finally {
    rmSync(temporaryEntry, { force: true });
  }
}

/** Called while holding the management lock; publishing the entry is a separate decision. */
export function installBundleFiles(
  paths: ReturnType<typeof nodePaths>,
  bundleDirectory: string,
  metadata: BundleMetadata,
) {
  const version = metadata.version;
  const destination = join(paths.versionsDirectory, version);
  if (lstatIfPresent(destination)) {
    checkManagedDirectory(destination);
    const installed = verifyBundle(destination, version);
    probeBundle(destination, installed);
    if (JSON.stringify(installed) !== JSON.stringify(metadata))
      throw new Error("Same-version bundle differs from the installed files; do not overwrite it");
  } else {
    prepareManagedDirectory(paths.versionsDirectory);
    const stage = join(paths.versionsDirectory, `.install-${randomUUID()}`);
    try {
      mkdirSync(stage, { mode: 0o700 });
      writeFileSync(join(stage, ".mate-install-stage"), installationStageMarker, { mode: 0o600 });
      cpSync(bundleDirectory, stage, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      });
      rmSync(join(stage, ".mate-install-stage"));
      verifyBundle(stage, version);
      probeBundle(stage, metadata);
      createAtomicNoReplaceRename(
        join(runningBundleDirectory(), "app/apps/node/dist/files/rename-noreplace"),
      )(stage, destination);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  return destination;
}

export async function bootstrapInstall(
  bundleDirectory: string,
  version: string,
  paths = nodePaths(),
) {
  requireOrdinaryAccount();
  const metadata = verifyBundle(bundleDirectory, version);
  probeBundle(bundleDirectory, metadata);
  // Read-only checks precede any installation writes or entry replacement.
  preflightDirectory(dirname(paths.entry));
  preflightDirectory(paths.versionsDirectory);
  const oldVersion = installedEntryVersion(paths);
  if (oldVersion !== undefined) {
    const oldDirectory = join(paths.versionsDirectory, oldVersion);
    const oldBundle = verifyBundle(oldDirectory, oldVersion);
    probeBundle(oldDirectory, oldBundle);
  }
  const unit = lstatIfPresent(paths.unit);
  const unitText = unit?.isFile() ? readFileSync(paths.unit, "utf8") : undefined;
  if (unit) {
    if (!unit.isFile() || unit.uid !== process.getuid?.())
      throw new Error(`Non-Mate user unit conflict: ${paths.unit}`);
    const text = unitText ?? "";
    if (!text.startsWith("# Mate node service\n"))
      throw new Error(`Non-Mate user unit conflict: ${paths.unit}`);
    const unitVersion = text.match(/^# Mate bundle version: (.+)$/m)?.[1];
    if (unitVersion !== version)
      throw new Error(
        "A node user service uses another version; run mate node update with the complete bundle",
      );
    const entrypoints = bundleEntrypoints(join(paths.versionsDirectory, version));
    const serviceEntries = text.split("\n").filter((line) => line.startsWith("ExecStart="));
    const quote = (path: string) => JSON.stringify(path.replaceAll("%", "%%"));
    if (
      serviceEntries.length !== 1 ||
      serviceEntries[0] !==
        `ExecStart=:${quote(entrypoints.runtime)} ${quote(entrypoints.node)} --config-file ${quote(paths.configuration)}`
    )
      throw new Error(
        "The node user unit does not reference its declared complete bundle; use mate node update to diagnose it",
      );
    if (!existsSync(join(paths.versionsDirectory, version)))
      throw new Error(
        "The installed service bundle is missing; recover with the local bundle's mate node update",
      );
  }
  return withManagementLock(paths, () => {
    recoverInstallationStaging(paths, bundleDirectory);
    // Repeat mutable facts inside the lock, including another bootstrap's changes.
    if (installedEntryVersion(paths) !== oldVersion)
      throw new Error("Mate entry changed concurrently; retry bootstrap");
    const currentUnit = lstatIfPresent(paths.unit);
    if (
      (currentUnit?.isFile() ? readFileSync(paths.unit, "utf8") : undefined) !== unitText ||
      Boolean(currentUnit) !== Boolean(unit)
    )
      throw new Error("Node user unit changed concurrently; retry bootstrap");
    installBundleFiles(paths, bundleDirectory, metadata);
    prepareManagedDirectory(dirname(paths.entry));
    if (installedEntryVersion(paths) !== oldVersion)
      throw new Error("Mate entry changed while staging; installed files were preserved");
    publishManagementEntry(paths, version, oldVersion);
    return metadata;
  });
}
