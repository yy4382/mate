// Build the node release bundles: `node deploy/node/build-bundle.ts <version> [--arch x64|arm64] [--out <dir>]`.
// Each bundle is the official Node runtime, the node app and the `mate` CLI bundled into one script, and the
// command that runs it; next to it goes `<bundle>.sha256`. Runs on any host: nothing in it is compiled per platform.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { BUNDLE_ENTRIES, packBundle } from "../../apps/node/src/bundle.ts";

const NODE_VERSION = "24.21.0";
/** From https://nodejs.org/dist/v24.21.0/SHASUMS256.txt; the same Node the repo develops and tests on. */
const NODE_SHA256 = {
  x64: "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
  arm64: "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
} as const;
type Arch = keyof typeof NODE_SHA256;

const COMMAND = `#!/bin/sh
program=$(dirname "$(dirname "$(readlink -f "$0")")")
exec "$program/${BUNDLE_ENTRIES.runtime}" "$program/${BUNDLE_ENTRIES.script}" "$@"
`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    arch: { type: "string", multiple: true },
    out: { type: "string", default: join(root, "dist/node-bundles") },
  },
});
const version = positionals[0];
const arches = (values.arch ?? Object.keys(NODE_SHA256)) as Arch[];
if (
  positionals.length !== 1 ||
  version === undefined ||
  arches.some((arch) => !(arch in NODE_SHA256))
) {
  process.stderr.write(
    "Usage: node deploy/node/build-bundle.ts <version> [--arch x64|arm64] [--out <dir>]\n",
  );
  process.exit(2);
}

const script = await build({
  entryPoints: [join(root, "apps/node/src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  conditions: ["mate-source"],
  // Bundled CommonJS dependencies (ws) call require() for Node built-ins.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  write: false,
  logLevel: "warning",
});

mkdirSync(values.out, { recursive: true });
for (const arch of arches) {
  const runtime = await nodeRuntime(arch);
  const archive = packBundle({ version, platform: "linux", arch }, [
    { path: BUNDLE_ENTRIES.command, content: Buffer.from(COMMAND), executable: true },
    { path: BUNDLE_ENTRIES.runtime, content: runtime.node, executable: true },
    { path: "node/LICENSE", content: runtime.license, executable: false },
    {
      path: BUNDLE_ENTRIES.script,
      content: Buffer.from(script.outputFiles[0]!.contents),
      executable: false,
    },
  ]);
  const path = join(values.out, `mate-node-${version}-linux-${arch}.tar.gz`);
  writeFileSync(path, archive);
  writeFileSync(`${path}.sha256`, `${sha256(archive)}  ${basename(path)}\n`);
  process.stdout.write(`${path}\n${path}.sha256\n`);
}

/** The official Node binary and its licence for `arch`, downloaded once into dist/ and checked every time. */
async function nodeRuntime(arch: Arch): Promise<{ node: Buffer; license: Buffer }> {
  const name = `node-v${NODE_VERSION}-linux-${arch}`;
  const cache = join(root, "dist/node-runtime");
  const tarball = join(cache, `${name}.tar.gz`);
  mkdirSync(cache, { recursive: true });
  if (readOrUndefined(tarball) === undefined) {
    const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.gz`);
    if (!response.ok) throw new Error(`downloading ${name}: HTTP ${response.status}`);
    writeFileSync(`${tarball}.part`, Buffer.from(await response.arrayBuffer()));
    renameSync(`${tarball}.part`, tarball);
  }
  if (sha256(readFileSync(tarball)) !== NODE_SHA256[arch]) {
    rmSync(tarball);
    throw new Error(`${tarball} does not match the pinned SHA-256; it was removed, run again`);
  }
  const unpacked = mkdtempSync(join(tmpdir(), "mate-node-runtime-"));
  try {
    const members = [`${name}/bin/node`, `${name}/LICENSE`];
    const result = spawnSync("tar", ["-xzf", tarball, "-C", unpacked, ...members], {
      stdio: "inherit",
    });
    if (result.status !== 0) throw new Error(`tar could not unpack ${tarball}`);
    return {
      node: readFileSync(join(unpacked, members[0]!)),
      license: readFileSync(join(unpacked, members[1]!)),
    };
  } finally {
    rmSync(unpacked, { recursive: true, force: true });
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function readOrUndefined(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}
