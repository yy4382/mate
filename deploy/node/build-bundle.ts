import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { packBundle } from "../../apps/node/src/bundle.ts";
import { bundleLayouts } from "../../apps/node/src/platforms/bundle-layout.ts";
import { nodeRuntimes, readNodeRuntime } from "./node-runtimes.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    platform: { type: "string", multiple: true },
    arch: { type: "string", multiple: true },
    out: { type: "string", default: join(root, "dist/node-bundles") },
  },
});
const version = positionals[0];
const selectedPlatforms = values.platform?.map((platform) =>
  platform === "win" ? "win32" : platform,
);
const invalidPlatform = selectedPlatforms?.some(
  (platform) => !Object.hasOwn(bundleLayouts, platform),
);
const invalidArch = values.arch?.some((arch) => arch !== "x64" && arch !== "arm64");
if (
  positionals.length !== 1 ||
  version === undefined ||
  !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) ||
  invalidPlatform ||
  invalidArch
) {
  process.stderr.write(
    "Usage: node deploy/node/build-bundle.ts <version> [--platform linux|darwin|win32] [--arch x64|arm64] [--out <dir>]\n",
  );
  process.exit(2);
}
const runtimes = nodeRuntimes.filter((runtime) => {
  return (
    (selectedPlatforms === undefined || selectedPlatforms.includes(runtime.platform)) &&
    (values.arch === undefined || values.arch.includes(runtime.arch))
  );
});

const script = await build({
  entryPoints: [join(root, "apps/node/src/main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  conditions: ["mate-source"],
  define: { __MATE_NODE_VERSION__: JSON.stringify(version) },
  // Bundled CommonJS dependencies (ws) call require() for Node built-ins.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  write: false,
  logLevel: "warning",
});

mkdirSync(values.out, { recursive: true });
for (const runtime of runtimes) {
  const layout = bundleLayouts[runtime.platform];
  const files = await readNodeRuntime(runtime, join(root, "dist/node-runtime"));
  const archive = packBundle({ version, platform: runtime.platform, arch: runtime.arch }, [
    { path: layout.command, content: Buffer.from(layout.launcher), executable: true },
    { path: layout.runtime, content: files.node, executable: true },
    { path: "node/LICENSE", content: files.license, executable: false },
    {
      path: layout.script,
      content: Buffer.from(script.outputFiles[0]!.contents),
      executable: false,
    },
  ]);
  const path = join(values.out, `mate-node-${version}-${layout.name}-${runtime.arch}.tar.gz`);
  const digest = createHash("sha256").update(archive).digest("hex");
  writeFileSync(path, archive);
  writeFileSync(`${path}.sha256`, `${digest}  ${basename(path)}\n`);
  process.stdout.write(`${path}\n${path}.sha256\n`);
}
