import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
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
    if (sha256(content) !== runtime.sha256) {
      throw new Error(`downloaded ${name} does not match the pinned SHA-256`);
    }
    writeFileSync(`${archive}.part`, content);
    renameSync(`${archive}.part`, archive);
  }
  if (sha256(content) !== runtime.sha256) {
    rmSync(archive);
    throw new Error(`${archive} does not match the pinned SHA-256; it was removed, run again`);
  }
  const nodePath = `${name}/${layout.runtime.slice("node/".length)}`;
  const licensePath = `${name}/LICENSE`;
  if (runtime.format === "zip") {
    const files = readZipFiles(content, [nodePath, licensePath]);
    return { node: files.get(nodePath)!, license: files.get(licensePath)! };
  }
  const unpacked = mkdtempSync(join(tmpdir(), "mate-node-runtime-"));
  try {
    const result = spawnSync("tar", ["-xzf", archive, "-C", unpacked, nodePath, licensePath], {
      stdio: "inherit",
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) throw new Error(`tar could not unpack ${archive}`);
    return {
      node: readFileSync(join(unpacked, nodePath)),
      license: readFileSync(join(unpacked, licensePath)),
    };
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function readZipFiles(archive: Buffer, wanted: readonly string[]): Map<string, Buffer> {
  let end = archive.length - 22;
  const earliest = Math.max(0, end - 0xffff);
  while (end >= earliest) {
    if (
      archive.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + archive.readUInt16LE(end + 20) === archive.length
    ) {
      break;
    }
    end -= 1;
  }
  if (end < earliest) throw new Error("Node zip has no central directory");
  const count = archive.readUInt16LE(end + 10);
  const directorySize = archive.readUInt32LE(end + 12);
  const directoryOffset = archive.readUInt32LE(end + 16);
  if (
    archive.readUInt16LE(end + 4) !== 0 ||
    archive.readUInt16LE(end + 6) !== 0 ||
    archive.readUInt16LE(end + 8) !== count ||
    count === 0xffff ||
    directoryOffset + directorySize !== end
  ) {
    throw new Error("Node zip must use a single non-ZIP64 central directory");
  }

  const files = new Map<string, Buffer>();
  let offset = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Node zip has an invalid central directory entry");
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const checksum = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > end) throw new Error("Node zip has a truncated central directory entry");
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset = entryEnd;
    if (!wanted.includes(name)) continue;
    if (files.has(name)) throw new Error(`Node zip lists ${name} twice`);
    if ((flags & 1) !== 0 || (method !== 0 && method !== 8)) {
      throw new Error(`Node zip uses an unsupported compression method for ${name}`);
    }
    if (
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      localOffset + 30 > directoryOffset ||
      archive.readUInt32LE(localOffset) !== 0x04034b50
    ) {
      throw new Error(`Node zip has an invalid local entry for ${name}`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const localName = archive.toString(
      "utf8",
      localOffset + 30,
      localOffset + 30 + localNameLength,
    );
    if (
      localName !== name ||
      archive.readUInt16LE(localOffset + 6) !== flags ||
      archive.readUInt16LE(localOffset + 8) !== method ||
      dataOffset + compressedSize > directoryOffset
    ) {
      throw new Error(`Node zip has an inconsistent local entry for ${name}`);
    }
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    const content =
      method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: size });
    if (content.length !== size || crc32(content) !== checksum) {
      throw new Error(`Node zip has corrupt content for ${name}`);
    }
    files.set(name, content);
  }
  if (offset !== end) throw new Error("Node zip central directory has unexpected data");
  for (const name of wanted) {
    if (!files.has(name)) throw new Error(`Node zip lacks ${name}`);
  }
  return files;
}
