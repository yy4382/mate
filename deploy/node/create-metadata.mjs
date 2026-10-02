import { createHash } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { bundleMetadata, releaseVersion } from "../../apps/node/dist/management/bundle.js";

const [directory, requestedVersion] = process.argv.slice(2);
if (!directory) throw new Error("Bundle directory is required");
const version = releaseVersion.parse(requestedVersion);
const files = [];
const symbols = [];
function visit(relative) {
  for (const name of readdirSync(join(directory, relative)).sort()) {
    const path = relative ? `${relative}/${name}` : name;
    const absolute = join(directory, path);
    const info = lstatSync(absolute);
    if (info.isDirectory()) {
      chmodSync(absolute, 0o755);
      visit(path);
      continue;
    }
    if (!info.isFile()) throw new Error(`Bundle contains a non-regular file: ${path}`);
    const content = readFileSync(absolute);
    if (content.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      const result = spawnSync("readelf", ["--version-info", absolute], { encoding: "utf8" });
      if (result.status !== 0)
        throw new Error(`Cannot inspect native library requirements: ${path}`);
      symbols.push(...result.stdout.matchAll(/Name: (GLIBC|GLIBCXX|CXXABI)_([\d.]+)/g));
    }
    const executable = (info.mode & 0o111) !== 0;
    chmodSync(absolute, executable ? 0o755 : 0o644);
    files.push({ path, sha256: createHash("sha256").update(content).digest("hex"), executable });
  }
}
visit("");
function highest(prefix) {
  const values = symbols.filter((symbol) => symbol[1] === prefix).map((symbol) => symbol[2]);
  values.sort((a, b) => {
    const aa = a.split(".").map(Number),
      bb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
      const difference = (aa[i] ?? 0) - (bb[i] ?? 0);
      if (difference) return difference;
    }
    return 0;
  });
  return values.at(-1) ?? "none";
}
const metadata = bundleMetadata.parse({
  format: 1,
  version,
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
  buildSystem: { id: "debian", version: "12" },
  systemLibraries: {
    glibc: highest("GLIBC"),
    glibcxx: highest("GLIBCXX"),
    cxxabi: highest("CXXABI"),
  },
  targetSystems: ["ubuntu:24.04", "debian:13"],
  files,
});
const probe = spawnSync(
  join(directory, "node/bin/node"),
  [
    "--input-type=module",
    "-e",
    `const { nativeProbe } = await import(${JSON.stringify(join(directory, "app/apps/node/dist/management/bundle.js"))}); await nativeProbe(${JSON.stringify(directory)});`,
  ],
  { encoding: "utf8" },
);
if (probe.status !== 0)
  throw new Error(`Packaged runtime/native dependencies failed build preflight: ${probe.stderr}`);
writeFileSync(join(directory, "bundle.json"), `${JSON.stringify(metadata, null, 2)}\n`, {
  mode: 0o644,
});
process.stdout.write(
  `Built ${metadata.version} ${metadata.architecture}: ${JSON.stringify(metadata.systemLibraries)}; target-system acceptance is separate.\n`,
);
