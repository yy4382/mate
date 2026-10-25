import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleLayouts } from "../../apps/node/src/platforms/bundle-layout.ts";
import type { PlatformId } from "../../apps/node/src/platforms/types.ts";

export const NODE_VERSION = "24.21.0";

export type NodeRuntime = {
  platform: PlatformId;
  arch: "x64" | "arm64";
  format: "tar.gz" | "zip";
  sha256: string;
};

// https://nodejs.org/dist/v24.21.0/SHASUMS256.txt
export const nodeRuntimes: readonly NodeRuntime[] = [
  {
    platform: "linux",
    arch: "x64",
    format: "tar.gz",
    sha256: "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
  },
  {
    platform: "linux",
    arch: "arm64",
    format: "tar.gz",
    sha256: "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
  },
  {
    platform: "darwin",
    arch: "x64",
    format: "tar.gz",
    sha256: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
  },
  {
    platform: "darwin",
    arch: "arm64",
    format: "tar.gz",
    sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
  },
  {
    platform: "win32",
    arch: "x64",
    format: "zip",
    sha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
  },
  {
    platform: "win32",
    arch: "arm64",
    format: "zip",
    sha256: "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921",
  },
];

export async function readNodeRuntime(
  runtime: NodeRuntime,
  cache: string,
): Promise<{ node: Buffer; license: Buffer }> {
  const layout = bundleLayouts[runtime.platform];
  const name = `node-v${NODE_VERSION}-${layout.name}-${runtime.arch}`;
  const archive = join(cache, `${name}.${runtime.format}`);
  mkdirSync(cache, { recursive: true });
  let content: Buffer;
  try {
    content = readFileSync(archive);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const response = await fetch(
      `https://nodejs.org/dist/v${NODE_VERSION}/${name}.${runtime.format}`,
    );
    if (!response.ok) throw new Error(`downloading ${name}: HTTP ${response.status}`);
    content = Buffer.from(await response.arrayBuffer());
    writeFileSync(`${archive}.part`, content);
    renameSync(`${archive}.part`, archive);
  }
  if (sha256(content) !== runtime.sha256) {
    rmSync(archive);
    throw new Error(`${archive} does not match the pinned SHA-256; it was removed, run again`);
  }
  const nodePath = `${name}/${layout.runtime.slice("node/".length)}`;
  const licensePath = `${name}/LICENSE`;
  const extract = (path: string): Buffer => {
    const useUnzip = runtime.format === "zip" && process.platform !== "win32";
    const command = useUnzip ? "unzip" : "tar";
    const args = useUnzip ? ["-p", archive, path] : ["-xOf", archive, path];
    const result = spawnSync(command, args, { maxBuffer: 256 * 1024 * 1024 });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${command} could not extract ${path}: ${result.stderr.toString()}`);
    }
    return result.stdout;
  };
  return { node: extract(nodePath), license: extract(licensePath) };
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
