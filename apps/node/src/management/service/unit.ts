import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bundleEntrypoints, releaseVersionSchema } from "../bundle.js";
import { lstatIfPresent } from "../install-entry.js";
import { nodePaths } from "../paths.js";
import type { ServiceFacts } from "./systemd.js";
import { createAtomicNoReplaceRename } from "../../files/mutations/atomic-rename.js";

const quoteServiceArgument = (value: string) => {
  if (/[\r\n\0]/.test(value))
    throw new Error("Service paths cannot contain newline or NUL characters");
  return JSON.stringify(value.replaceAll("%", "%%"));
};
export function renderNodeUnit(paths: ReturnType<typeof nodePaths>, version: string) {
  const entries = bundleEntrypoints(
    join(paths.versionsDirectory, releaseVersionSchema.parse(version)),
  );
  // ':' disables environment substitution in literal absolute arguments; quote also escapes '%'.
  // WorkingDirectory is a scalar, not an ExecStart word; '~' selects this account's home.
  return `# Mate node service
# Mate bundle version: ${version}
[Unit]
Description=Mate Linux node

[Service]
Type=exec
ExecStart=:${quoteServiceArgument(entries.runtime)} ${quoteServiceArgument(entries.node)} --config-file ${quoteServiceArgument(paths.configuration)}
UnsetEnvironment=GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
WorkingDirectory=~
Restart=on-failure
RestartSec=5s
KillMode=mixed
TimeoutStopSec=45s
UMask=0077

[Install]
WantedBy=default.target
`;
}

export function serviceReferencesBundle(
  facts: ServiceFacts,
  paths: ReturnType<typeof nodePaths>,
  version: string,
) {
  const entries = bundleEntrypoints(join(paths.versionsDirectory, version));
  const command = facts.execStart[0];
  return (
    facts.type === "exec" &&
    facts.execStart.length === 1 &&
    command?.flags.length === 1 &&
    command.flags[0] === "no-env-expand" &&
    command?.path === entries.runtime &&
    JSON.stringify(command.argv) ===
      JSON.stringify([entries.runtime, entries.node, "--config-file", paths.configuration])
  );
}

export function recoverUnitStaging(paths: ReturnType<typeof nodePaths>, version: string) {
  if (!lstatIfPresent(dirname(paths.unit))) return;
  const expected = renderNodeUnit(paths, version);
  for (const name of readdirSync(dirname(paths.unit))) {
    if (
      !/^\.mate-node-unit-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name)
    )
      continue;
    const file = join(dirname(paths.unit), name);
    const info = lstatIfPresent(file);
    if (
      !info?.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      !expected.startsWith(readFileSync(file, "utf8"))
    )
      throw new Error(`Unknown interrupted user unit file was preserved: ${file}`);
    rmSync(file);
  }
}

function readManagedUnitFile(paths: ReturnType<typeof nodePaths>, file: string) {
  const info = lstatIfPresent(file);
  if (!info) return undefined;
  if (!info.isFile() || info.uid !== process.getuid?.())
    throw new Error(`Non-Mate user unit conflict: ${file}`);
  const text = readFileSync(file, "utf8");
  const version = text.match(/^# Mate bundle version: (.+)$/m)?.[1];
  if (
    !version ||
    !releaseVersionSchema.safeParse(version).success ||
    text !== renderNodeUnit(paths, version)
  )
    throw new Error(
      `Non-Mate or modified user unit conflict: ${file}; keep custom service environment in a systemd drop-in`,
    );
  return version;
}

export function readManagedUnit(paths: ReturnType<typeof nodePaths>) {
  return readManagedUnitFile(paths, paths.unit);
}

/** A moved unit is its own ownership evidence, not a persisted maintenance intent. */
export function interruptedUnitFiles(paths: ReturnType<typeof nodePaths>) {
  if (!lstatIfPresent(dirname(paths.unit))) return [];
  return readdirSync(dirname(paths.unit))
    .filter((name) =>
      /^\.mate-node-previous-unit-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        name,
      ),
    )
    .map((name) => {
      const file = join(dirname(paths.unit), name);
      return { file, version: readManagedUnitFile(paths, file) };
    });
}

export function publishNodeUnit({
  paths,
  version,
  previousVersion,
  bundleDirectory,
}: {
  paths: ReturnType<typeof nodePaths>;
  version: string;
  previousVersion: string | undefined;
  bundleDirectory: string;
}) {
  const noReplace = createAtomicNoReplaceRename(
    join(bundleDirectory, "app/apps/node/dist/files/rename-noreplace"),
  );
  const temporary = join(dirname(paths.unit), `.mate-node-unit-${randomUUID()}`);
  const previous = join(dirname(paths.unit), `.mate-node-previous-unit-${randomUUID()}`);
  try {
    writeFileSync(temporary, renderNodeUnit(paths, version), { mode: 0o600, flag: "wx" });
    if (previousVersion !== undefined) {
      noReplace(paths.unit, previous);
      if (readManagedUnitFile(paths, previous) !== previousVersion)
        throw new Error(
          `Concurrent user unit was preserved at ${previous}; resolve it before retrying update`,
        );
    }
    noReplace(temporary, paths.unit);
    for (const backup of interruptedUnitFiles(paths)) rmSync(backup.file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
