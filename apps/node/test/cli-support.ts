import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { temporaryDirectory } from "./support.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** What the fake `systemctl` knows about `mate-node.service`, and every call it got. */
export type FakeSystemd = {
  available: boolean;
  active: string;
  enabled: string;
  /** What the unit's `MainPID` reports; 0 when nothing runs. */
  mainPid: number;
  calls: string[][];
  journal: string[][];
};

// The fake answers only for the one unit and reads the unit file the way the real user manager would find it.
const FAKE_SYSTEMCTL = `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_SYSTEMD;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const exit = (code) => { fs.writeFileSync(file, JSON.stringify(state)); process.exit(code); };
state.calls.push(args);
if (!state.available) { console.error("Failed to connect to bus: No medium found"); exit(1); }
const unit = process.env.HOME + "/.config/systemd/user/mate-node.service";
const [scope, verb, ...rest] = args;
if (scope !== "--user") exit(1);
const now = rest.includes("--now");
if (verb === "show") {
  const loaded = fs.existsSync(unit);
  process.stdout.write("LoadState=" + (loaded ? "loaded" : "not-found") + "\\nActiveState=" + state.active + "\\nUnitFileState=" + (loaded ? state.enabled : "") + "\\nMainPID=" + state.mainPid + "\\n");
} else if (verb === "enable" && fs.existsSync(unit)) {
  state.enabled = "enabled";
  if (now) state.active = "active";
} else if (verb === "disable") {
  state.enabled = "disabled";
  if (now) state.active = "inactive";
} else if (verb !== "daemon-reload") {
  console.error("fake systemctl cannot " + args.join(" "));
  exit(1);
}
exit(0);
`;

const FAKE_JOURNALCTL = `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_SYSTEMD;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
state.journal.push(process.argv.slice(2));
fs.writeFileSync(file, JSON.stringify(state));
process.stdout.write("a journal line\\n");
`;

export type Result = { status: number | null; stdout: string; stderr: string };

/** An account's home with a fake systemd on PATH, and the `mate` CLI run as that account. */
export type Host = {
  home: string;
  /** A directory outside the home for bundles and other inputs. */
  inputs: string;
  env: NodeJS.ProcessEnv;
  mate(...args: string[]): Result;
  /** Start `mate` without waiting for it, for a test that kills it midway. */
  spawnMate(...args: string[]): ChildProcess;
  /** The same CLI invocation, for a test that wraps it in another command. */
  argv(...args: string[]): string[];
  systemd(): FakeSystemd;
  setSystemd(change: Partial<FakeSystemd>): void;
};

export function host(): Host {
  const root = temporaryDirectory();
  const home = join(root, "home");
  const inputs = join(root, "inputs");
  const bin = join(root, "bin");
  for (const directory of [home, inputs, bin]) mkdirSync(directory);
  const state = join(root, "systemd.json");
  writeFileSync(
    state,
    JSON.stringify({
      available: true,
      active: "inactive",
      enabled: "",
      mainPid: 0,
      calls: [],
      journal: [],
    }),
  );
  for (const [name, script] of [
    ["systemctl", FAKE_SYSTEMCTL],
    ["journalctl", FAKE_JOURNALCTL],
  ] as const) {
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o755);
  }
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env["PATH"]}`,
    FAKE_SYSTEMD: state,
  };
  const argv = (...args: string[]) => [process.execPath, "--conditions=mate-source", main, ...args];
  const systemd = (): FakeSystemd => JSON.parse(readFileSync(state, "utf8"));
  return {
    home,
    inputs,
    env,
    argv,
    mate(...args) {
      const [command, ...rest] = argv(...args);
      const result = spawnSync(command!, rest, { env, encoding: "utf8", cwd: inputs });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    spawnMate(...args) {
      const [command, ...rest] = argv(...args);
      return spawn(command!, rest, { env, cwd: inputs, stdio: "ignore" });
    },
    systemd,
    setSystemd(change) {
      writeFileSync(state, JSON.stringify({ ...systemd(), ...change }));
    },
  };
}

export type TarEntry =
  | { path: string; type: "file"; content: Buffer | string; mode?: number }
  | { path: string; type: "directory" }
  | { path: string; type: "symlink" | "hardlink"; target: string }
  | { path: string; type: "fifo" };

export type BundleOptions = {
  version: string;
  /** Replaces the manifest's file list; by default it lists exactly the bundle's files. */
  listed?: string[];
  platform?: string;
  arch?: string;
  /** Entries added after the regular ones. */
  extra?: TarEntry[];
  /** A large file, for a test that needs unpacking to take a while. */
  bigFileBytes?: number;
  checksum?: "valid" | "wrong" | "missing";
};

/**
 * Write `mate-node-<version>.tar.gz` and its `.sha256` into `directory` the way the release build does: a ustar
 * archive with everything under `mate-node/` and a manifest listing the files. Options make it wrong in one way.
 */
export function writeBundle(directory: string, options: BundleOptions): string {
  const files: Record<string, string | Buffer> = {
    "bin/mate": "#!/bin/sh\n",
    "node/bin/node": `node runtime for ${options.version}\n`,
    "lib/mate.mjs": `// mate ${options.version}\n`,
  };
  if (options.bigFileBytes !== undefined) {
    files["lib/big.bin"] = randomBytes(options.bigFileBytes);
  }
  const manifest = {
    version: options.version,
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    files: options.listed ?? Object.keys(files),
  };
  const entries: TarEntry[] = [
    { path: "mate-node/", type: "directory" },
    { path: "mate-node/manifest.json", type: "file", content: JSON.stringify(manifest) },
    ...Object.entries(files).map(([path, content]): TarEntry => ({
      path: `mate-node/${path}`,
      type: "file",
      content,
      mode: path.startsWith("bin/") || path.startsWith("node/bin/") ? 0o755 : 0o644,
    })),
    ...(options.extra ?? []),
  ];
  const name = `mate-node-${options.version}.tar.gz`;
  const archive = gzipSync(tar(entries), { level: 1 });
  const path = join(directory, name);
  writeFileSync(path, archive);
  const digest = createHash("sha256")
    .update(options.checksum === "wrong" ? "something else" : archive)
    .digest("hex");
  if (options.checksum !== "missing") writeFileSync(`${path}.sha256`, `${digest}  ${name}\n`);
  return path;
}

function tar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content =
      entry.type === "file"
        ? Buffer.isBuffer(entry.content)
          ? entry.content
          : Buffer.from(entry.content)
        : Buffer.alloc(0);
    const header = Buffer.alloc(512);
    const octal = (value: number, start: number, length: number) =>
      header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, start, "ascii");
    header.write(entry.path, 0, "utf8");
    octal(entry.type === "file" ? (entry.mode ?? 0o644) : 0o755, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(content.length, 124, 12);
    octal(0, 136, 12);
    header.fill(" ", 148, 156);
    const types = { file: "0", directory: "5", symlink: "2", hardlink: "1", fifo: "6" };
    header.write(types[entry.type], 156, "ascii");
    if (entry.type === "symlink" || entry.type === "hardlink") header.write(entry.target, 157);
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** Every path under `directory` with its type, permissions and content or link target, to compare before and after. */
export function snapshot(directory: string): string[] {
  const lines: string[] = [];
  const visit = (relative: string) => {
    for (const name of readdirSync(join(directory, relative)).sort()) {
      const path = join(relative, name);
      const absolute = join(directory, path);
      const stat = lstatSync(absolute);
      const mode = (stat.mode & 0o777).toString(8);
      if (stat.isSymbolicLink()) lines.push(`${path} -> ${readlinkSync(absolute)}`);
      else if (stat.isDirectory()) {
        lines.push(`${path}/ ${mode}`);
        visit(path);
      } else {
        const digest = createHash("sha256").update(readFileSync(absolute)).digest("hex");
        lines.push(`${path} ${mode} ${digest}`);
      }
    }
  };
  visit("");
  return lines;
}
