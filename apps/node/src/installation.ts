import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { readManifest, unlisted, unpackBundle, type Manifest } from "./bundle.ts";
import { readConfig } from "./config.ts";
import { readLink } from "./link.ts";

import { currentPlatform } from "./platforms/index.ts";
import { lstatOrUndefined } from "./platforms/service-files.ts";
import type { Layout, Ownership } from "./platforms/types.ts";

export const EXIT_DO_NOT_RESTART = 78;
export type { Layout } from "./platforms/types.ts";

const SCRATCH = /^\.mate-node-(staging|old)-/;

type Program =
  | { kind: "absent" }
  | { kind: "installed"; manifest: Manifest; unlisted: string[] }
  /** A directory at the program path without a manifest Mate can read. */
  | { kind: "foreign" };

function readProgram(layout: Layout): Program {
  const stat = lstatOrUndefined(layout.program);
  if (stat === undefined) return { kind: "absent" };
  const manifest = stat.isDirectory() ? readManifest(layout.program) : undefined;
  if (manifest === undefined) return { kind: "foreign" };
  return { kind: "installed", manifest, unlisted: unlisted(layout.program, manifest) };
}

export async function install(bundle: string, layout: Layout): Promise<string[]> {
  const program = readProgram(layout);
  refuseForeignProgram(layout, program);
  const service = currentPlatform().service(layout);
  service.inspect();
  const report = [await place(bundle, layout, program, "keep")];
  return [
    ...report,
    ...currentPlatform().launcher.install(layout),
    ...service.install(),
    ...nextSteps(layout),
  ];
}

export async function update(bundle: string, layout: Layout): Promise<string[]> {
  const program = readProgram(layout);
  refuseForeignProgram(layout, program);
  refuseUnlisted(layout, program);
  const service = currentPlatform().service(layout);
  const state = service.inspect();
  if (state.activity !== "stopped") {
    throw new Error(
      `The node service is ${state.description}. Stop it with \`mate node stop\` first; nothing was changed.`,
    );
  }
  const report = [await place(bundle, layout, program, "replace")];
  return [
    ...report,
    ...currentPlatform().launcher.install(layout),
    ...service.install(),
    ...nextSteps(layout),
  ];
}

export function uninstall(layout: Layout): string[] {
  const program = readProgram(layout);
  refuseForeignProgram(layout, program);
  refuseUnlisted(layout, program);
  const service = currentPlatform().service(layout);
  service.inspect();
  const report = [...service.uninstall(), ...currentPlatform().launcher.remove(layout)];
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
  if (readConfig(layout.config) === undefined) {
    throw new Error(
      `${layout.config} is missing; run \`mate node configure --control-plane <url> --pairing-token <token>\` first.`,
    );
  }
  return currentPlatform().service(layout).start();
}

export function stop(layout: Layout): string[] {
  return currentPlatform().service(layout).stop();
}

export function status(layout: Layout): string[] {
  const program = readProgram(layout);
  const lines = [`Program: ${describeProgram(layout, program)}`];
  const platform = currentPlatform();
  lines.push(`Command: ${describeOwnership(layout.command, platform.launcher.ownership(layout))}`);
  try {
    const service = platform.service(layout);
    const state = service.inspect();
    lines.push(`Unit: ${describeOwnership(layout.unit, state.ownership)}`);
    lines.push(`Service: ${state.description}`);
    const link = readLink(layout.data);
    const linked = link !== undefined && service.ownsProcess(link.pid, link.since);
    lines.push(
      `Link: ${linked ? `${link.connected ? "connected" : "disconnected"} since ${link.since}` : "none"}`,
    );
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

export function logs(layout: Layout, lines: number, follow: boolean): number {
  return currentPlatform().service(layout).logs(lines, follow);
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

function nextSteps(layout: Layout): string[] {
  const config = safeConfig(layout);
  const service = currentPlatform().service(layout).inspect();
  if (service.activity === "running") {
    return ["The node service is running; it keeps the version it started with until restarted."];
  }
  if (service.activity !== "stopped") {
    return [`The node service is ${service.description}. Use \`mate node status\` to inspect it.`];
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

function readdirOrEmpty(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
