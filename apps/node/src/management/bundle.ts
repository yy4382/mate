import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  mkdtempSync,
  rmSync,
  openSync,
  closeSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const releaseVersion = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/, "Use an explicit Mate release version");
const filePath = z
  .string()
  .refine(
    (value) =>
      value !== "bundle.json" &&
      !value.startsWith("/") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
    "Invalid bundle file path",
  );
export const bundleMetadata = z
  .object({
    format: z.literal(1),
    version: releaseVersion,
    nodeVersion: z.string().regex(/^v24\.\d+\.\d+$/),
    platform: z.literal("linux"),
    architecture: z.enum(["x64", "arm64"]),
    buildSystem: z.object({ id: z.literal("debian"), version: z.literal("12") }).strict(),
    systemLibraries: z
      .object({ glibc: z.string(), glibcxx: z.string(), cxxabi: z.string() })
      .strict(),
    targetSystems: z.tuple([z.literal("ubuntu:24.04"), z.literal("debian:13")]),
    files: z
      .array(
        z
          .object({
            path: filePath,
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            executable: z.boolean(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type BundleMetadata = z.infer<typeof bundleMetadata>;

export function runningBundleDirectory() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
}

export function bundleEntrypoints(directory: string) {
  return {
    runtime: join(directory, "node/bin/node"),
    cli: join(directory, "app/apps/node/dist/management/cli.js"),
    node: join(directory, "app/apps/node/dist/main.js"),
  };
}

export function readBundle(directory: string) {
  const metadata = bundleMetadata.parse(
    JSON.parse(readFileSync(join(directory, "bundle.json"), "utf8")),
  );
  if (new Set(metadata.files.map((file) => file.path)).size !== metadata.files.length)
    throw new Error("Bundle metadata contains duplicate files");
  return metadata;
}

/** Verify every regular file; archives and installed bundles must contain no links. */
export function verifyBundle(directory: string, expectedVersion?: string) {
  const metadata = readBundle(directory);
  if (expectedVersion !== undefined && metadata.version !== releaseVersion.parse(expectedVersion))
    throw new Error(
      `Bundle version ${metadata.version} does not match requested ${expectedVersion}`,
    );
  if (process.platform !== "linux" || process.arch !== metadata.architecture)
    throw new Error(
      `Bundle requires Linux ${metadata.architecture}; this machine is ${process.platform} ${process.arch}`,
    );
  const system = readFileSync("/etc/os-release", "utf8");
  const osValue = (key: string) => system.match(new RegExp(`^${key}=["']?([^"'\\n]+)`, "m"))?.[1];
  const target = `${osValue("ID")}:${osValue("VERSION_ID")}`;
  if (!metadata.targetSystems.some((supported) => supported === target))
    throw new Error(`Unsupported system ${target}; use Ubuntu 24.04 or Debian 13`);
  const actualFiles = new Set<string>();
  const visit = (relative: string) => {
    for (const name of readdirSync(join(directory, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      const info = lstatSync(join(directory, path));
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) actualFiles.add(path);
      else throw new Error(`Bundle contains a link or special file: ${path}`);
    }
  };
  visit("");
  actualFiles.delete("bundle.json");
  for (const file of metadata.files) {
    if (!actualFiles.delete(file.path)) throw new Error(`Bundle file is missing: ${file.path}`);
    const absolute = join(directory, file.path);
    if (createHash("sha256").update(readFileSync(absolute)).digest("hex") !== file.sha256)
      throw new Error(`Bundle file checksum mismatch: ${file.path}`);
    if (((lstatSync(absolute).mode & 0o111) !== 0) !== file.executable)
      throw new Error(`Bundle file executable mode mismatch: ${file.path}`);
  }
  if (actualFiles.size > 0)
    throw new Error(`Bundle contains unexpected files: ${[...actualFiles].join(", ")}`);
  for (const required of [
    "node/bin/node",
    "app/apps/node/dist/main.js",
    "app/apps/node/dist/management/cli.js",
    "app/apps/node/dist/files/rename-noreplace",
    "bin/mate",
  ])
    if (!metadata.files.some((file) => file.path === required))
      throw new Error(`Incomplete bundle: ${required}`);
  return metadata;
}

/** Run with the bundle's Node, loading both native addons and the rename helper. */
export function probeBundle(directory: string, metadata = readBundle(directory)) {
  const runtime = join(directory, "node/bin/node");
  const version = spawnSync(runtime, ["--version"], { encoding: "utf8" });
  if (version.status !== 0 || version.stdout.trim() !== metadata.nodeVersion)
    throw new Error("Dedicated Node is unavailable or does not match bundle metadata");
  const result = spawnSync(
    runtime,
    [join(directory, "app/apps/node/dist/management/cli.js"), "--native-probe"],
    { encoding: "utf8", env: withoutDownloadCredentials(process.env) },
  );
  if (result.status !== 0)
    throw new Error("Bundle native runtime preflight failed; verify platform and system libraries");
}

export function withoutDownloadCredentials(environment: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].includes(
          key,
        ),
    ),
  );
}

export async function nativeProbe(directory: string) {
  const { default: Database } = await import("better-sqlite3");
  const { default: locks } = await import("fs-ext");
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE probe (value TEXT)");
  } finally {
    db.close();
  }
  const temporary = mkdtempSync(join(tmpdir(), "mate-native-probe-"));
  try {
    writeFileSync(join(temporary, "source"), "probe");
    const fd = openSync(join(temporary, "source"), "r");
    const dirFd = openSync(temporary, "r");
    try {
      locks.flockSync(fd, "exnb");
      locks.flockSync(fd, "un");
      const result = spawnSync(
        join(directory, "app/apps/node/dist/files/rename-noreplace"),
        ["source", "destination"],
        { stdio: ["ignore", "pipe", "pipe", dirFd, dirFd] },
      );
      if (result.status !== 0 || readFileSync(join(temporary, "destination"), "utf8") !== "probe")
        throw new Error("Native rename helper failed");
    } finally {
      closeSync(fd);
      closeSync(dirFd);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function assertDedicatedRuntime(directory: string) {
  if (realpathSync(process.execPath) !== realpathSync(join(directory, "node/bin/node")))
    throw new Error("Run Mate with this bundle's dedicated Node runtime");
}
