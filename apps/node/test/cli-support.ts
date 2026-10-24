import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, onTestFinished } from "vitest";
import { temporaryDirectory } from "./support.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const fake = fileURLToPath(new URL("./fixtures/service-manager.cjs", import.meta.url));

export type FakeService = {
  available: boolean;
  active: string;
  enabled: string;
  mainPid: number;
  loaded: boolean;
  foreignDefinition: boolean;
  unverifiedProcess?: boolean;
  created?: string;
  calls: string[][];
  journal: string[][];
};

export type HostPaths = {
  program: string;
  command: string;
  unit: string;
  config: string;
  data: string;
  workspaces: string;
};

export function hostPaths(home: string, localAppData = join(home, "AppData/Local")): HostPaths {
  if (process.platform === "win32") {
    const root = join(localAppData, "Mate");
    return {
      program: join(root, "program"),
      command: join(root, "bin/mate.cmd"),
      unit: join(root, "config/node-task.xml"),
      config: join(root, "config/node.json"),
      data: join(root, "data"),
      workspaces: join(home, "mate/workspaces"),
    };
  }
  return {
    program: join(home, ".local/lib/mate-node"),
    command: join(home, ".local/bin/mate"),
    unit: join(
      home,
      process.platform === "darwin"
        ? "Library/LaunchAgents/io.mate.node.plist"
        : ".config/systemd/user/mate-node.service",
    ),
    config: join(home, ".config/mate/node.json"),
    data: join(home, ".local/share/mate/node"),
    workspaces: join(home, "mate/workspaces"),
  };
}

let windowsRunner: string | undefined;
const runnerDirectories = new Set<string>();
afterAll(() => {
  for (const directory of runnerDirectories) rmSync(directory, { recursive: true, force: true });
});

function executableRunner(): string {
  if (windowsRunner !== undefined) return windowsRunner;
  const directory = mkdtempSync(join(tmpdir(), "mate-cli-runner-"));
  runnerDirectories.add(directory);
  const source = fileURLToPath(new URL("./fixtures/service-runner.cs", import.meta.url));
  const executable = join(directory, "runner.exe");
  const compiler = join(process.env["WINDIR"]!, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  const built = spawnSync(compiler, ["/nologo", "/target:exe", `/out:${executable}`, source], {
    encoding: "utf8",
  });
  if (built.status !== 0)
    throw new Error(`Cannot build the Windows command fixture: ${built.stdout} ${built.stderr}`);
  windowsRunner = executable;
  return executable;
}

export type Result = { status: number | null; stdout: string; stderr: string };

export type SpawnedMate = { child: ChildProcess; closed: Promise<void> };

export type Host = {
  home: string;
  inputs: string;
  paths: HostPaths;
  env: NodeJS.ProcessEnv;
  mate(...args: string[]): Result;
  spawnMate(...args: string[]): SpawnedMate;
  argv(...args: string[]): string[];
  service(): FakeService;
  setService(change: Partial<FakeService>): void;
};

export function serviceChanges(h: Host): string[][] {
  return h.service().calls.filter(([tool, first, second]) => {
    if (tool === "systemctl") return second !== "show" && second !== "daemon-reload";
    if (tool === "launchctl") return first !== "print" && first !== "print-disabled";
    if (tool === "schtasks") return first !== "/Create";
    return tool === "taskkill";
  });
}

export function host(): Host {
  const root = temporaryDirectory();
  const home = join(root, "home");
  const inputs = join(root, "inputs");
  const bin = join(root, "bin");
  for (const directory of [home, inputs, bin]) mkdirSync(directory);
  const paths = hostPaths(home);
  const state = join(root, "service.json");
  writeFileSync(
    state,
    JSON.stringify({
      available: true,
      active: "inactive",
      enabled: "",
      mainPid: 0,
      loaded: false,
      foreignDefinition: false,
      calls: [],
      journal: [],
    }),
  );
  const commands =
    process.platform === "win32"
      ? ["powershell", "schtasks", "taskkill"]
      : ["systemctl", "journalctl", "launchctl", "tail"];
  for (const command of commands) {
    if (process.platform === "win32") copyFileSync(executableRunner(), join(bin, `${command}.exe`));
    else {
      const path = join(bin, command);
      writeFileSync(
        path,
        `#!/usr/bin/env node\nprocess.argv.splice(2, 0, ${JSON.stringify(command)});\nrequire(process.env.MATE_FAKE_SERVICE_SCRIPT);\n`,
      );
      chmodSync(path, 0o755);
    }
  }
  const replaced = new Set(["PATH", "HOME", "USERPROFILE", "LOCALAPPDATA"]);
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !replaced.has(key.toUpperCase())),
  );
  const env = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData/Local"),
    PATH: `${bin}${delimiter}${process.env["PATH"] ?? process.env["Path"]}`,
    MATE_FAKE_SERVICE_STATE: state,
    MATE_FAKE_SERVICE_PATHS: JSON.stringify(paths),
    MATE_FAKE_SERVICE_SCRIPT: fake,
    MATE_TEST_NODE: process.execPath,
  };
  const argv = (...args: string[]) => [process.execPath, "--conditions=mate-source", main, ...args];
  const service = (): FakeService => JSON.parse(readFileSync(state, "utf8"));
  return {
    home,
    inputs,
    paths,
    env,
    argv,
    service,
    mate(...args) {
      const [command, ...rest] = argv(...args);
      const result = spawnSync(command!, rest, { env, encoding: "utf8", cwd: inputs });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    spawnMate(...args) {
      const [command, ...rest] = argv(...args);
      const child = spawn(command!, rest, { env, cwd: inputs, stdio: "ignore" });
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      onTestFinished(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      });
      return { child, closed };
    },
    setService(change) {
      writeFileSync(state, JSON.stringify({ ...service(), ...change }));
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
  const windows = process.platform === "win32";
  const files: Record<string, string | Buffer> = {
    [windows ? "bin/mate.cmd" : "bin/mate"]: windows ? "@echo off\r\n" : "#!/bin/sh\n",
    [windows ? "node/node.exe" : "node/bin/node"]: `node runtime for ${options.version}\n`,
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
