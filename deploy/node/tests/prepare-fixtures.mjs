import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const [archiveArgument, outputArgument] = process.argv.slice(2);
if (!archiveArgument || !outputArgument) throw new Error("ARCHIVE and fixture OUTPUT are required");
const archive = resolve(archiveArgument);
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
function tar(args) {
  const result = spawnSync("tar", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}
function variant(name, change) {
  const stage = mkdtempSync(join(tmpdir(), "mate-bundle-input-"));
  try {
    tar(["-xzf", archive, "-C", stage]);
    const bundle = join(stage, "mate-node");
    const metadata = JSON.parse(readFileSync(join(bundle, "bundle.json"), "utf8"));
    change(bundle, metadata);
    writeFileSync(join(bundle, "bundle.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    const file = join(output, `${name}.tar.gz`);
    tar(["-czf", file, "-C", stage, "mate-node"]);
    writeFileSync(`${file}.sha256`, createHash("sha256").update(readFileSync(file)).digest("hex"));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
variant("wrong-architecture", (_bundle, metadata) => {
  metadata.architecture = metadata.architecture === "arm64" ? "x64" : "arm64";
});
variant("wrong-runtime", (_bundle, metadata) => {
  metadata.nodeVersion = "v24.0.0";
});
variant("corrupt-file", (bundle) => {
  writeFileSync(join(bundle, "app/apps/node/dist/main.js"), "corrupted release file\n");
});
variant("unsafe-link", (bundle) => {
  symlinkSync("/etc/passwd", join(bundle, "escape"));
});
// This is a download-tool substitute only; the actual bundled Node and CLI still execute.
writeFileSync(
  join(output, "gh"),
  `#!/bin/sh
set -eu
[ "$1" = release ] && [ "$2" = download ] || exit 1
[ -n "$GH_TOKEN" ] || exit 1
while [ "$#" -gt 0 ]; do
  if [ "$1" = --dir ]; then
    destination=$2
    break
  fi
  shift
done
cp "$MATE_TEST_ASSET" "$destination/$(basename "$archive")"
cp "$MATE_TEST_CHECKSUMS" "$destination/SHA256SUMS"
`,
  { mode: 0o755 },
);
