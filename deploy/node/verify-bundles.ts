import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

const directory = process.argv[2];
if (process.argv.length !== 3 || directory === undefined) {
  process.stderr.write("Usage: node deploy/node/verify-bundles.ts <bundle-directory>\n");
  process.exit(2);
}

const bundles = readdirSync(directory).filter((name) => name.endsWith(".tar.gz"));
assert(bundles.length > 0, `${directory} has no bundles`);
for (const name of bundles.sort()) {
  const match = /^mate-node-(.+)-(linux|darwin|win)-(x64|arm64)\.tar\.gz$/.exec(name);
  assert(match !== null, `unexpected bundle name: ${name}`);
  const [, version, target, arch] = match;
  const platform = target === "win" ? "win32" : target;
  const runtime = target === "win" ? "node/node.exe" : "node/bin/node";
  const command = target === "win" ? "bin/mate.cmd" : "bin/mate";
  const expectedFiles = [command, runtime, "node/LICENSE", "lib/mate.mjs"].sort();
  const archivePath = resolve(directory, name);
  const archive = readFileSync(archivePath);
  const digest = createHash("sha256").update(archive).digest("hex");
  assert.equal(readFileSync(`${archivePath}.sha256`, "utf8"), `${digest}  ${name}\n`);

  const tar = gunzipSync(archive);
  const files = new Map<string, Buffer>();
  let offset = 0;
  let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    assert.equal(header.toString("ascii", 257, 263), "ustar\0", `${name} uses ustar`);
    const path = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    const type = header.toString("ascii", 156, 157);
    const size = Number.parseInt(header.toString("ascii", 124, 136), 8);
    assert(Number.isSafeInteger(size) && size >= 0, `${name} has a valid entry size`);
    assert(offset + size <= tar.length, `${name} is not truncated`);
    if (type === "0") {
      assert(!files.has(path), `${name} lists each file once`);
      files.set(path, tar.subarray(offset, offset + size));
      const mode = Number.parseInt(header.toString("ascii", 100, 108), 8);
      const executable = path === `mate-node/${runtime}` || path === `mate-node/${command}`;
      assert.equal(mode, executable ? 0o755 : 0o644, `${path} has the intended mode`);
    } else {
      assert.equal(type, "5", `${name} contains only files and directories`);
      assert.equal(size, 0, `${name} directory has no content`);
      assert(/^mate-node(?:\/[A-Za-z0-9_-]+)*\/$/.test(path), `${name} has a safe directory`);
    }
    offset += Math.ceil(size / 512) * 512;
  }
  assert(ended && tar.length - offset >= 512, `${name} has two ustar end blocks`);
  assert(
    tar.subarray(offset).every((byte) => byte === 0),
    `${name} has only ustar end padding`,
  );
  assert.deepEqual(
    [...files.keys()].sort(),
    [...expectedFiles, "manifest.json"].map((path) => `mate-node/${path}`).sort(),
    `${name} has exactly the release files`,
  );
  const manifest = JSON.parse(files.get("mate-node/manifest.json")!.toString("utf8"));
  assert.deepEqual(manifest, { version, platform, arch, files: [...manifest.files] });
  assert.deepEqual([...manifest.files].sort(), expectedFiles, `${name} manifest lists every file`);
  assert(
    files.get("mate-node/node/LICENSE")!.includes("Node.js"),
    `${name} includes the Node license`,
  );
  process.stdout.write(`${name}: checksum, ustar, manifest and release files verified\n`);

  if (platform !== process.platform || arch !== process.arch) {
    process.stdout.write(`${name}: runtime execution requires a matching host\n`);
    continue;
  }
  const temporary = mkdtempSync(join(tmpdir(), "mate bundle verify "));
  try {
    const unpacked = spawnSync("tar", ["-xzf", archivePath, "-C", temporary], { encoding: "utf8" });
    assert.equal(unpacked.status, 0, unpacked.stderr || String(unpacked.error));
    const program = join(temporary, "mate-node");
    const runtimeInfo = spawnSync(
      join(program, runtime),
      [
        "-p",
        "JSON.stringify({version: process.version, platform: process.platform, arch: process.arch})",
      ],
      { encoding: "utf8" },
    );
    assert.equal(runtimeInfo.status, 0, runtimeInfo.stderr || String(runtimeInfo.error));
    assert.deepEqual(JSON.parse(runtimeInfo.stdout), { version: "v24.21.0", platform, arch });
    const home = join(temporary, "home");
    mkdirSync(home);
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, "AppData", "Local"),
    };
    const launcher = join(program, command);
    const cli =
      target === "win"
        ? spawnSync("cmd.exe", ["/d", "/s", "/c", `""${launcher}" node run"`], {
            env,
            encoding: "utf8",
            windowsVerbatimArguments: true,
          })
        : spawnSync(launcher, ["node", "run"], { env, encoding: "utf8" });
    assert.equal(cli.status, 78, cli.stderr || String(cli.error));
    assert.match(cli.stderr, /mate node configure/);
    if (target !== "win") {
      const link = join(temporary, "mate link");
      symlinkSync("mate-node/bin/mate", link);
      const linked = spawnSync(link, ["node", "run"], { env, encoding: "utf8" });
      assert.equal(linked.status, 78, linked.stderr || String(linked.error));
      assert.match(linked.stderr, /mate node configure/);
    }
    process.stdout.write(`${name}: official runtime and bundled CLI executed on this host\n`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
