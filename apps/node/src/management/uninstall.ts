import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readBundle, releaseVersion } from "./bundle.js";
import { readNodeConfiguration } from "./configuration.js";
import {
  checkManagedDirectory,
  installedEntryVersion,
  lstatIfPresent,
  requireOrdinaryAccount,
  recoverInstallationStaging,
  withManagementLock,
} from "./install-entry.js";
import { nodePaths } from "./paths.js";
import {
  readManagedUnit,
  renderNodeUnit,
  serviceReferencesBundle,
  interruptedUnitFiles,
  recoverUnitStaging,
} from "./service/commands.js";
import { systemdUserManager } from "./service/systemd.js";
import { finishSameVersionRepair } from "./repair-bundle.js";
import { createAtomicNoReplaceRename } from "../files/mutations/atomic-rename.js";

function inspectRemovalStaging(paths: ReturnType<typeof nodePaths>) {
  const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  const files = [];
  for (const { directory, pattern, unit } of [
    {
      directory: dirname(paths.unit),
      pattern: new RegExp(`^\\.mate-removing-unit-${uuid}$`),
      unit: true,
    },
    {
      directory: dirname(paths.entry),
      pattern: new RegExp(`^\\.mate-removing-${uuid}$`),
      unit: false,
    },
  ]) {
    if (!lstatIfPresent(directory)) continue;
    checkManagedDirectory(directory);
    for (const name of readdirSync(directory)) {
      if (!pattern.test(name)) continue;
      const file = join(directory, name),
        info = lstatIfPresent(file);
      if (!info || info.uid !== process.getuid?.())
        throw new Error(`Unknown interrupted removal file preserved: ${file}`);
      if (unit) {
        const text = info.isFile() ? readFileSync(file, "utf8") : "",
          version = text.match(/^# Mate bundle version: (.+)$/m)?.[1];
        if (
          !version ||
          !releaseVersion.safeParse(version).success ||
          text !== renderNodeUnit(paths, version)
        )
          throw new Error(`Unknown interrupted removal unit preserved: ${file}`);
      } else {
        const target = info.isSymbolicLink() ? readlinkSync(file) : "",
          prefix = `${paths.versionsDirectory}/`;
        const version =
          target.startsWith(prefix) && target.endsWith("/bin/mate")
            ? target.slice(prefix.length, -"/bin/mate".length)
            : "";
        if (!releaseVersion.safeParse(version).success)
          throw new Error(`Unknown interrupted removal entry preserved: ${file}`);
      }
      files.push(file);
    }
  }
  return files;
}

function checkExistingAncestors(paths: ReturnType<typeof nodePaths>, path: string) {
  const part = relative(paths.home, path);
  if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part))
    throw new Error("Managed paths must remain under the existing account home");
  let current = paths.home;
  checkManagedDirectory(current);
  for (const name of part.split(sep)) {
    current = join(current, name);
    if (lstatIfPresent(current)) checkManagedDirectory(current);
  }
}

function retainedLocations(paths: ReturnType<typeof nodePaths>, ensureSeparate = true) {
  const config = lstatIfPresent(paths.configuration)
    ? readNodeConfiguration(paths.configuration, paths)
    : undefined;
  const data = config?.dataDirectory ?? paths.dataDirectory,
    workspace = config?.agentWorkspaceRoot ?? join(data, "agents");
  const canonical = (path: string) => {
    const missing = [];
    let ancestor = resolve(path);
    while (!lstatIfPresent(ancestor)) {
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
    return join(realpathSync(ancestor), ...missing);
  };
  for (const retained of ensureSeparate ? [paths.configDirectory, data, workspace] : []) {
    const part = relative(canonical(paths.programDirectory), canonical(retained));
    const reverse = relative(canonical(retained), canonical(paths.programDirectory));
    const nested = (value: string) =>
      value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
    if (nested(part) || nested(reverse))
      throw new Error(
        "Retained data/configuration/workspaces overlap removable programs; resolve configuration before uninstall",
      );
  }
  return `Preserved configuration: ${paths.configDirectory}\nPreserved node identity: ${join(data, "node-identity.json")}\nPreserved operation receipts: ${data}\nPreserved Agent workspaces: ${workspace}\nPreserved control-plane database/model credentials/attachments: the MATE_CONTROL_PLANE_DATA_DIR bind directory from your Compose .env (not managed or discovered by the node CLI)\n`;
}

/** Remaining files must match the original inventory, so interrupted deletion can resume. */
function remainingProgramFiles(directory: string, version: string) {
  checkManagedDirectory(directory);
  const manifest = lstatIfPresent(join(directory, "bundle.json"));
  if (!manifest?.isFile() || manifest.uid !== process.getuid?.())
    throw new Error(`Unconfirmed bundle inventory preserved: ${directory}`);
  const metadata = readBundle(directory);
  if (metadata.version !== version) throw new Error(`Conflicting program version: ${directory}`);
  const records = new Map(metadata.files.map((file) => [file.path, file]));
  for (const required of [
    "bin/mate",
    "node/bin/node",
    "app/apps/node/dist/main.js",
    "app/apps/node/dist/management/cli.js",
    "app/apps/node/dist/files/rename-noreplace",
  ])
    if (!records.has(required))
      throw new Error(`Unconfirmed Mate program inventory preserved: ${directory}`);
  const directories = new Set([""]);
  for (const file of records.keys()) {
    let parent = dirname(file);
    while (parent !== ".") {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  const files: string[] = [],
    folders: string[] = [];
  const visit = (part: string) => {
    checkManagedDirectory(join(directory, part));
    for (const name of readdirSync(join(directory, part))) {
      const path = part ? `${part}/${name}` : name,
        absolute = join(directory, path),
        info = lstatIfPresent(absolute);
      if (path === "bundle.json" && info?.isFile() && info.uid === process.getuid?.()) continue;
      if (info?.isDirectory() && directories.has(path)) {
        visit(path);
        folders.push(absolute);
        continue;
      }
      const record = records.get(path);
      if (
        !record ||
        !info?.isFile() ||
        info.uid !== process.getuid?.() ||
        createHash("sha256").update(readFileSync(absolute)).digest("hex") !== record.sha256 ||
        ((info.mode & 0o111) !== 0) !== record.executable
      )
        throw new Error(`Non-Mate or changed program file preserved: ${absolute}`);
      files.push(absolute);
    }
  };
  visit("");
  return {
    directory,
    files,
    folders,
    records,
    manifest,
    manifestHash: createHash("sha256")
      .update(readFileSync(join(directory, "bundle.json")))
      .digest("hex"),
    identities: new Map([...files, ...folders].map((file) => [file, lstatIfPresent(file)])),
  };
}

export async function uninstallNode(
  paths: ReturnType<typeof nodePaths>,
  runningDirectory: string,
  manager = systemdUserManager,
) {
  requireOrdinaryAccount();
  const completed: string[] = [];
  let preserved = `Preserved configuration: ${paths.configDirectory}\nPreserved default node identity: ${join(paths.dataDirectory, "node-identity.json")}\nPreserved default operation receipts: ${paths.dataDirectory}\nPreserved default Agent workspaces: ${join(paths.dataDirectory, "agents")}\nCustom locations could not be read from ${paths.configuration}; no data was removed.\nPreserved control-plane database/model credentials/attachments: the MATE_CONTROL_PLANE_DATA_DIR bind directory from your Compose .env\n`;
  try {
    try {
      preserved = retainedLocations(paths, false);
    } catch {
      // Damaged configuration must not prevent stopping an owned service. The destructive
      // program phase validates it again and fails before deleting any program files.
    }
    for (const path of [paths.programDirectory, dirname(paths.entry), dirname(paths.unit)])
      checkExistingAncestors(paths, path);
    manager.assertAvailable({ effectiveCommand: false });
    return await withManagementLock(paths, () => {
      const interrupted = inspectRemovalStaging(paths);
      const previousUnits = interruptedUnitFiles(paths);
      if (!lstatIfPresent(paths.unit) && previousUnits[0]) {
        createAtomicNoReplaceRename(
          join(runningDirectory, "app/apps/node/dist/files/rename-noreplace"),
        )(previousUnits[0].file, paths.unit);
        completed.push(
          "Moved owned unit restored only to stop/disable it; no service installed or started",
        );
      }
      const selected = installedEntryVersion(paths),
        unitVersion = readManagedUnit(paths),
        facts = manager.inspect({ effectiveCommand: false });
      if (facts.load !== "not-found" && facts.fragment !== paths.unit)
        throw new Error(`Non-Mate manager unit conflict: ${facts.fragment}`);
      if (!unitVersion && facts.load !== "not-found") {
        const effective = manager.inspect(),
          candidate = effective.execStart[0]?.path;
        const version = candidate?.startsWith(`${paths.versionsDirectory}/`)
          ? candidate.slice(paths.versionsDirectory.length + 1).split("/")[0]
          : undefined;
        if (
          !version ||
          !releaseVersion.safeParse(version).success ||
          !serviceReferencesBundle(effective, paths, version)
        )
          throw new Error(
            "Missing unit file has unconfirmed manager ownership; resolve the service conflict before uninstall",
          );
      }
      if (unitVersion || facts.load !== "not-found") {
        manager.run("stop");
        const stopped = manager.inspect({ effectiveCommand: false });
        if (
          !["inactive", "failed"].includes(stopped.active) ||
          stopped.pid !== 0 ||
          ("job" in stopped && stopped.job !== 0)
        )
          throw new Error("User service did not stop; program files preserved");
        completed.push("User service stopped");
        if (unitVersion) {
          manager.run("disable");
          completed.push("User service disabled");
        } else if (
          ["enabled", "enabled-runtime", "linked", "linked-runtime"].includes(stopped.enabled)
        ) {
          throw new Error(
            "Missing user unit still has enablement links; ownership cannot be confirmed, program files preserved",
          );
        }
        if (unitVersion) {
          if (readManagedUnit(paths) !== unitVersion)
            throw new Error("User unit changed during uninstall; preserved");
          const temporary = join(dirname(paths.unit), `.mate-removing-unit-${randomUUID()}`),
            move = createAtomicNoReplaceRename(
              join(runningDirectory, "app/apps/node/dist/files/rename-noreplace"),
            );
          move(paths.unit, temporary);
          try {
            const info = lstatIfPresent(temporary);
            if (
              !info?.isFile() ||
              info.uid !== process.getuid?.() ||
              readFileSync(temporary, "utf8") !== renderNodeUnit(paths, unitVersion)
            )
              throw new Error("User unit changed concurrently; conflicting file preserved");
            rmSync(temporary);
          } catch (error) {
            try {
              move(temporary, paths.unit);
            } catch {
              throw new Error(`Unit cleanup failed; conflicting file preserved at ${temporary}`);
            }
            throw error;
          }
          completed.push("Mate user unit removed");
        }
      } else completed.push("User service already absent");
      manager.run("daemon-reload");
      const reloaded = manager.inspect({ effectiveCommand: false });
      if (
        reloaded.load !== "not-found" ||
        !["inactive", "failed"].includes(reloaded.active) ||
        reloaded.pid !== 0
      )
        throw new Error("User service remains loaded after reload; program files preserved");
      completed.push("User manager reloaded");
      preserved = retainedLocations(paths);
      recoverInstallationStaging(paths, runningDirectory);
      if (previousUnits.length) {
        for (const backup of interruptedUnitFiles(paths)) rmSync(backup.file);
        completed.push("Owned interrupted update unit backups cleaned");
      }
      const unitStages =
        lstatIfPresent(dirname(paths.unit)) &&
        readdirSync(dirname(paths.unit)).some((name) => name.startsWith(".mate-node-unit-"));
      const repairStages = lstatIfPresent(paths.versionsDirectory)
        ? readdirSync(paths.versionsDirectory)
            .filter((name) =>
              /^\.repair-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name),
            )
            .map((name) => join(paths.versionsDirectory, name))
        : [];
      if (unitStages || repairStages.length) {
        // The command's complete bundle was verified before entering this boundary. Repair
        // backups need this trusted same-version inventory; a name alone never authorizes deletion.
        const metadata = readBundle(runningDirectory);
        if (unitStages) recoverUnitStaging(paths, metadata.version);
        for (const directory of repairStages) {
          checkManagedDirectory(directory);
          if (readdirSync(directory).length === 0) {
            rmdirSync(directory);
            continue;
          }
          const manifest = lstatIfPresent(join(directory, "bundle.json"));
          if (
            !manifest?.isFile() ||
            manifest.uid !== process.getuid?.() ||
            JSON.stringify(readBundle(directory)) !== JSON.stringify(metadata)
          )
            throw new Error(
              `Repair inventory cannot be confirmed: ${directory}; retry uninstall from a verified local complete bundle of that inventory's original version`,
            );
          finishSameVersionRepair([directory], metadata);
          completed.push(`Owned interrupted repair backup cleaned: ${directory}`);
        }
      }
      for (const file of interrupted) {
        checkExistingAncestors(paths, dirname(file));
        if (!inspectRemovalStaging(paths).includes(file))
          throw new Error(`Interrupted removal file changed; preserved: ${file}`);
        rmSync(file);
        completed.push(`Interrupted removal file cleaned: ${file}`);
      }
      const bundles = [];
      for (const name of readdirSync(paths.programDirectory))
        if (!["versions", "management.lock"].includes(name))
          throw new Error(
            `Unrecognized program file preserved: ${join(paths.programDirectory, name)}`,
          );
      if (lstatIfPresent(paths.versionsDirectory)) {
        checkManagedDirectory(paths.versionsDirectory);
        for (const version of readdirSync(paths.versionsDirectory)) {
          if (!releaseVersion.safeParse(version).success)
            throw new Error(
              `Unrecognized program directory preserved: ${join(paths.versionsDirectory, version)}`,
            );
          const directory = join(paths.versionsDirectory, version);
          checkManagedDirectory(directory);
          if (readdirSync(directory).length === 0) {
            completed.push(`Empty directory preserved (no program files): ${directory}`);
            continue;
          }
          bundles.push(remainingProgramFiles(join(paths.versionsDirectory, version), version));
        }
      }
      bundles.sort(
        (a, b) =>
          Number(basename(a.directory) === selected) - Number(basename(b.directory) === selected),
      );
      const removeBundle = (bundle: ReturnType<typeof remainingProgramFiles>) => {
        for (const file of bundle.files) {
          checkExistingAncestors(paths, dirname(file));
          const info = lstatIfPresent(file),
            previous = bundle.identities.get(file),
            record = bundle.records.get(relative(bundle.directory, file).split(sep).join("/"));
          if (
            !info?.isFile() ||
            info.uid !== process.getuid?.() ||
            info.dev !== previous?.dev ||
            info.ino !== previous.ino ||
            !record ||
            createHash("sha256").update(readFileSync(file)).digest("hex") !== record.sha256 ||
            ((info.mode & 0o111) !== 0) !== record.executable
          )
            throw new Error(`Program file changed before removal; preserved: ${file}`);
          rmSync(file);
        }
        for (const folder of bundle.folders) {
          checkExistingAncestors(paths, folder);
          const info = lstatIfPresent(folder),
            previous = bundle.identities.get(folder);
          if (info?.dev !== previous?.dev || info?.ino !== previous?.ino)
            throw new Error(`Program directory changed before removal; preserved: ${folder}`);
          rmdirSync(folder);
        }
        checkExistingAncestors(paths, bundle.directory);
        const manifest = lstatIfPresent(join(bundle.directory, "bundle.json"));
        if (
          !manifest?.isFile() ||
          manifest.uid !== process.getuid?.() ||
          manifest.dev !== bundle.manifest.dev ||
          manifest.ino !== bundle.manifest.ino ||
          createHash("sha256")
            .update(readFileSync(join(bundle.directory, "bundle.json")))
            .digest("hex") !== bundle.manifestHash
        )
          throw new Error(`Program inventory changed; preserved: ${bundle.directory}`);
        rmSync(join(bundle.directory, "bundle.json"));
        rmdirSync(bundle.directory);
        completed.push(`Program bundle removed: ${bundle.directory}`);
      };
      for (const bundle of bundles.filter(
        (bundle) =>
          basename(bundle.directory) !== selected &&
          resolve(bundle.directory) !== resolve(runningDirectory),
      ))
        removeBundle(bundle);
      if (selected !== undefined) {
        if (installedEntryVersion(paths) !== selected)
          throw new Error("Management entry changed; preserved");
        // Rename first, then inspect the object actually moved; never unlink a replaced foreign entry.
        const temporary = join(dirname(paths.entry), `.mate-removing-${randomUUID()}`),
          move = createAtomicNoReplaceRename(
            join(runningDirectory, "app/apps/node/dist/files/rename-noreplace"),
          );
        move(paths.entry, temporary);
        try {
          const info = lstatIfPresent(temporary);
          if (
            !info?.isSymbolicLink() ||
            info.uid !== process.getuid?.() ||
            readlinkSync(temporary) !== join(paths.versionsDirectory, selected, "bin/mate")
          )
            throw new Error("Management entry changed concurrently; foreign file preserved");
          rmSync(temporary);
        } catch (error) {
          try {
            move(temporary, paths.entry);
          } catch {
            throw new Error(`Entry cleanup failed; conflicting file preserved at ${temporary}`);
          }
          throw error;
        }
        completed.push("Management entry removed");
      } else completed.push("Management entry already absent");
      // All manager calls and native helpers have finished. Loaded modules/runtime remain mapped;
      // final deletion only uses these in-memory functions and ordinary filesystem operations.
      for (const bundle of bundles.filter(
        (bundle) =>
          basename(bundle.directory) === selected ||
          resolve(bundle.directory) === resolve(runningDirectory),
      ))
        removeBundle(bundle);
      return `${completed.join("\n")}\n${preserved}The reusable management.lock file is retained to keep concurrent commands on one lock inode.\nControl-plane containers are removed separately with Compose down; their bind data remains.\n`;
    });
  } catch (error) {
    throw new Error(
      `Uninstall incomplete: ${error instanceof Error ? error.message : "cleanup failed"}\nCompleted: ${completed.join("; ") || "none"}\nRemaining cleanup: inspect ${paths.unit}, ${paths.entry} and ${paths.versionsDirectory}; retry the same uninstall using a verified local complete bundle.\n${preserved}`,
    );
  }
}
