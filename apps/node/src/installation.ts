import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BUNDLE_ENTRIES, readManifest, unlisted, unpackBundle, type Manifest } from "./bundle.ts";
import { readConfig } from "./config.ts";
import { readLink } from "./link.ts";

/**
 * What `mate node` manages, all under the account's home. Install, update and uninstall touch only the program
 * directory, the `mate` command link and the unit file. The config, the identity in the data directory and the
 * workspaces are never touched by them.
 */
export type Layout = {
  /** The unpacked bundle; replaced as a whole, never edited in place. */
  program: string;
  /** A symlink to the program's `bin/mate`. */
  command: string;
  unit: string;
  config: string;
  /** The node's identity key. */
  data: string;
  /** The workspaces root `configure` writes when the admin names none. */
  workspaces: string;
};

const PROGRAM = ".local/lib/mate-node";
const SERVICE = "mate-node.service";
/** Mate's own scratch directories next to the program directory; any found at the start of a command are stale. */
const SCRATCH = /^\.mate-node-(staging|old)-/;
/** `node run` exits with this when restarting cannot help (no config, identity refused); the unit does not restart it. */
export const EXIT_DO_NOT_RESTART = 78;

export function layout(home = homedir()): Layout {
  return {
    program: join(home, PROGRAM),
    command: join(home, ".local/bin/mate"),
    unit: join(home, ".config/systemd/user", SERVICE),
    config: join(home, ".config/mate/node.json"),
    data: join(home, ".local/share/mate/node"),
    workspaces: join(home, "mate/workspaces"),
  };
}

const UNIT_HEADER =
  "# Written by `mate node`, which replaces this file. Put local changes in a drop-in.";
const UNIT = `${UNIT_HEADER}
[Unit]
Description=Mate node

[Service]
Type=exec
ExecStart=%h/${PROGRAM}/${BUNDLE_ENTRIES.runtime} %h/${PROGRAM}/${BUNDLE_ENTRIES.script} node run
Restart=on-failure
RestartSec=5s
RestartPreventExitStatus=${EXIT_DO_NOT_RESTART}
KillMode=mixed
TimeoutStopSec=45s
UMask=0077

[Install]
WantedBy=default.target
`;

type Program =
  | { kind: "absent" }
  | { kind: "installed"; manifest: Manifest; unlisted: string[] }
  /** A directory at the program path without a manifest Mate can read. */
  | { kind: "foreign" };

/** Who owns a path Mate manages: nobody yet, Mate, or someone else, whose file Mate leaves alone. */
type Ownership = "absent" | "mate" | "foreign";

type Service = { loaded: boolean; active: string; enabled: string; mainPid: number };

function readProgram(layout: Layout): Program {
  const stat = lstatOrUndefined(layout.program);
  if (stat === undefined) return { kind: "absent" };
  const manifest = stat.isDirectory() ? readManifest(layout.program) : undefined;
  if (manifest === undefined) return { kind: "foreign" };
  return { kind: "installed", manifest, unlisted: unlisted(layout.program, manifest) };
}

function commandOwnership(layout: Layout): Ownership {
  const stat = lstatOrUndefined(layout.command);
  if (stat === undefined) return "absent";
  return stat.isSymbolicLink() && readlinkSync(layout.command) === commandTarget(layout)
    ? "mate"
    : "foreign";
}

function unitOwnership(layout: Layout): Ownership {
  const stat = lstatOrUndefined(layout.unit);
  if (stat === undefined) return "absent";
  return stat.isFile() && readFileSync(layout.unit, "utf8").startsWith(`${UNIT_HEADER}\n`)
    ? "mate"
    : "foreign";
}

const commandTarget = (layout: Layout) => join(layout.program, BUNDLE_ENTRIES.command);

/** The service as the user manager sees it; throws when there is no user manager to ask. */
function readService(): Service {
  const values = new Map(
    systemctl("show", SERVICE, "--property=LoadState,ActiveState,UnitFileState,MainPID")
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return {
    loaded: values.get("LoadState") === "loaded",
    active: values.get("ActiveState") ?? "unknown",
    enabled: values.get("UnitFileState") ?? "",
    mainPid: Number(values.get("MainPID") ?? 0),
  };
}

/** No process of the service is running or about to run. */
const stopped = (service: Service) => service.active === "inactive" || service.active === "failed";

function systemctl(...args: string[]): string {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(
      `systemctl --user ${args.join(" ")} failed: ${detail}. The node needs this account's systemd user manager; log in as this account, or enable linger for it.`,
    );
  }
  return result.stdout;
}

export async function install(bundle: string, layout: Layout): Promise<string[]> {
  const program = readProgram(layout);
  refuseForeignProgram(layout, program);
  readService(); // Fails without a user manager, before anything changes.
  const report = [await place(bundle, layout, program, "keep")];
  return [...report, ...linkAndUnit(layout), ...nextSteps(layout)];
}

export async function update(bundle: string, layout: Layout): Promise<string[]> {
  const program = readProgram(layout);
  refuseForeignProgram(layout, program);
  refuseUnlisted(layout, program);
  const service = readService();
  if (!stopped(service)) {
    throw new Error(
      `The node service is ${service.active}. Stop it with \`mate node stop\` first; nothing was changed.`,
    );
  }
  const report = [await place(bundle, layout, program, "replace")];
  return [...report, ...linkAndUnit(layout), ...nextSteps(layout)];
}

export function uninstall(layout: Layout): string[] {
  const program = readProgram(layout);
  refuseForeignProgram(layout, program);
  refuseUnlisted(layout, program);
  const service = readService();
  const report: string[] = [];
  const unit = unitOwnership(layout);
  if (service.loaded && unit !== "foreign") {
    systemctl("disable", "--now", SERVICE);
    report.push("The node service is stopped and disabled.");
  }
  switch (unit) {
    case "mate":
      unlinkSync(layout.unit);
      systemctl("daemon-reload");
      report.push(`Removed ${layout.unit}.`);
      break;
    case "foreign":
      report.push(`Left ${layout.unit} and the service it defines alone: Mate did not write it.`);
  }
  switch (commandOwnership(layout)) {
    case "mate":
      unlinkSync(layout.command);
      report.push(`Removed ${layout.command}.`);
      break;
    case "foreign":
      report.push(`Left ${layout.command} alone: it is not Mate's link.`);
  }
  if (program.kind === "installed") {
    rmSync(moveAside(layout), { recursive: true, force: true });
    report.push(`Removed ${layout.program}.`);
  }
  removeScratch(layout);
  if (report.length === 0) report.push("Mate node is not installed; nothing to remove.");
  const workspaces = safeConfig(layout)?.workspacesRoot;
  report.push(
    `Kept the config (${layout.config}), the node identity (${layout.data})${workspaces === undefined ? "" : ` and the workspaces (${workspaces})`}.`,
  );
  return report;
}

export function start(layout: Layout): string[] {
  if (readProgram(layout).kind !== "installed") {
    throw new Error("Mate node is not installed; run `mate node install <bundle>` first.");
  }
  if (lstatOrUndefined(layout.unit) === undefined) {
    throw new Error(`${layout.unit} is missing; run \`mate node install <bundle>\` again.`);
  }
  if (readConfig(layout.config) === undefined) {
    throw new Error(
      `${layout.config} is missing; run \`mate node configure --control-plane <url> --pairing-token <token>\` first.`,
    );
  }
  systemctl("enable", "--now", SERVICE);
  return ["Started and enabled the node service; it starts again at login or boot."];
}

export function stop(): string[] {
  if (!readService().loaded) return ["No node service is installed; nothing to stop."];
  systemctl("disable", "--now", SERVICE);
  return ["Stopped and disabled the node service; it stays stopped until `mate node start`."];
}

/** The link file counts only when the process running now wrote it; a crashed node's file never claims a link. */
function describeLink(layout: Layout, service: Service): string {
  const link = readLink(layout.data);
  if (service.active !== "active" || service.mainPid === 0 || link?.pid !== service.mainPid) {
    return "none";
  }
  return `${link.connected ? "connected" : "disconnected"} since ${link.since}`;
}

export function status(layout: Layout): string[] {
  const program = readProgram(layout);
  const lines = [`Program: ${describeProgram(layout, program)}`];
  lines.push(`Command: ${describeOwnership(layout.command, commandOwnership(layout))}`);
  lines.push(`Unit: ${describeOwnership(layout.unit, unitOwnership(layout))}`);
  try {
    const service = readService();
    lines.push(
      `Service: ${service.loaded ? `${service.active}, ${service.enabled || "unknown"}` : "not installed"}`,
    );
    lines.push(`Link: ${describeLink(layout, service)}`);
  } catch (error) {
    lines.push(`Service: unknown (${(error as Error).message})`, "Link: none");
  }
  let config;
  try {
    config = readConfig(layout.config);
  } catch (error) {
    lines.push(`Config: ${(error as Error).message}`);
  }
  if (config !== undefined) {
    lines.push(
      `Config: ${layout.config}`,
      `  control plane: ${config.controlPlaneUrl}`,
      `  workspaces: ${config.workspacesRoot}`,
      `  pairing token: ${config.pairingToken === undefined ? "none" : "set"}`,
    );
  } else if (lstatOrUndefined(layout.config) === undefined) {
    lines.push(`Config: missing (${layout.config})`);
  }
  return lines;
}

export function logs(lines: number, follow: boolean): number {
  const result = spawnSync(
    "journalctl",
    ["--user", "--unit", SERVICE, "--lines", String(lines), ...(follow ? ["--follow"] : [])],
    { stdio: "inherit" },
  );
  if (result.error !== undefined) throw new Error(`journalctl failed: ${result.error.message}`);
  return result.status ?? 1;
}

/**
 * Make the program directory hold `bundle`'s version. The bundle is unpacked and checked in a scratch directory
 * first, so a bad bundle changes nothing. An installed program of another version is kept (install) or swapped out
 * by two renames (update); a run that dies between them leaves no program directory, and running the command again
 * installs from scratch.
 */
async function place(
  bundle: string,
  layout: Layout,
  program: Program,
  otherVersion: "keep" | "replace",
): Promise<string> {
  removeScratch(layout);
  const parent = dirname(layout.program);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, ".mate-node-staging-"));
  try {
    const incoming = await unpackBundle(bundle, staging);
    if (program.kind !== "installed") {
      renameSync(staging, layout.program);
      return `Installed Mate node ${incoming.version} in ${layout.program}.`;
    }
    const installed = program.manifest.version;
    if (installed === incoming.version) {
      return `Mate node ${installed} is already installed in ${layout.program}.`;
    }
    if (otherVersion === "keep") {
      throw new Error(
        `Mate node ${installed} is installed; use \`mate node update ${bundle}\` to change it to ${incoming.version}. Nothing was changed.`,
      );
    }
    const old = moveAside(layout);
    renameSync(staging, layout.program);
    rmSync(old, { recursive: true, force: true });
    return `Updated Mate node from ${installed} to ${incoming.version} in ${layout.program}.`;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Point `mate` at the program and write the unit, where Mate owns them; report what someone else owns. */
function linkAndUnit(layout: Layout): string[] {
  const report: string[] = [];
  switch (commandOwnership(layout)) {
    case "absent":
      mkdirSync(dirname(layout.command), { recursive: true });
      symlinkSync(commandTarget(layout), layout.command);
      report.push(`Linked ${layout.command} to ${commandTarget(layout)}.`);
      break;
    case "foreign":
      report.push(
        `Left ${layout.command} alone: it is not Mate's link. Run ${commandTarget(layout)} instead.`,
      );
  }
  const unit = unitOwnership(layout);
  if (unit === "foreign") {
    report.push(`Left ${layout.unit} alone: Mate did not write it.`);
  } else if (unit === "absent" || readFileSync(layout.unit, "utf8") !== UNIT) {
    mkdirSync(dirname(layout.unit), { recursive: true });
    const temporary = `${layout.unit}.mate-tmp`;
    writeFileSync(temporary, UNIT, { mode: 0o644 });
    renameSync(temporary, layout.unit);
    systemctl("daemon-reload");
    report.push(`Wrote ${layout.unit}.`);
  }
  return report;
}

function nextSteps(layout: Layout): string[] {
  const config = safeConfig(layout);
  const service = readService();
  if (!stopped(service)) {
    return ["The node service is running; it keeps the version it started with until restarted."];
  }
  return [
    ...(config === undefined
      ? [
          "Next: mate node configure --control-plane <url> --pairing-token <token> [--workspaces <dir>]",
        ]
      : []),
    "The node service is stopped. Start it with `mate node start`.",
  ];
}

function refuseForeignProgram(layout: Layout, program: Program): void {
  if (program.kind === "foreign") {
    throw new Error(
      `${layout.program} exists but has no Mate manifest, so Mate will not touch it. Move or delete it, then run the command again; nothing was changed.`,
    );
  }
}

function refuseUnlisted(layout: Layout, program: Program): void {
  if (program.kind === "installed" && program.unlisted.length > 0) {
    throw new Error(
      `${layout.program} holds files Mate did not install: ${program.unlisted.join(", ")}. Move them out, then run the command again; nothing was changed.`,
    );
  }
}

/**
 * Move the program directory into a fresh scratch directory and return that, so a run that dies while deleting it
 * leaves only scratch, which the next command removes.
 */
function moveAside(layout: Layout): string {
  const old = mkdtempSync(join(dirname(layout.program), ".mate-node-old-"));
  renameSync(layout.program, join(old, "program"));
  return old;
}

function removeScratch(layout: Layout): void {
  const parent = dirname(layout.program);
  for (const name of readdirOrEmpty(parent)) {
    if (SCRATCH.test(name)) rmSync(join(parent, name), { recursive: true, force: true });
  }
  rmSync(`${layout.unit}.mate-tmp`, { force: true });
}

function describeProgram(layout: Layout, program: Program): string {
  switch (program.kind) {
    case "absent":
      return `not installed (${layout.program})`;
    case "foreign":
      return `${layout.program} exists but has no Mate manifest`;
    case "installed": {
      const { version, platform, arch } = program.manifest;
      const extra =
        program.unlisted.length === 0
          ? ""
          : `; files Mate did not install: ${program.unlisted.join(", ")}`;
      return `${version} (${platform}-${arch}) in ${layout.program}${extra}`;
    }
  }
}

function describeOwnership(path: string, ownership: Ownership): string {
  switch (ownership) {
    case "absent":
      return `missing (${path})`;
    case "mate":
      return path;
    case "foreign":
      return `${path} (not Mate's; left alone)`;
  }
}

function safeConfig(layout: Layout) {
  try {
    return readConfig(layout.config);
  } catch {
    return undefined;
  }
}

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function readdirOrEmpty(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
