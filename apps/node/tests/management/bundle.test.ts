import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { readBundle, releaseVersion } from "../../src/management/bundle.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function metadataFile(change: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mate-bundle-contract-"));
  directories.push(directory);
  writeFileSync(
    join(directory, "bundle.json"),
    JSON.stringify({
      format: 1,
      version: "0.1.0",
      nodeVersion: "v24.21.0",
      platform: "linux",
      architecture: "arm64",
      buildSystem: { id: "debian", version: "12" },
      systemLibraries: { glibc: "2.36", glibcxx: "3.4.30", cxxabi: "1.3.13" },
      targetSystems: ["ubuntu:24.04", "debian:13"],
      files: [{ path: "node/bin/node", sha256: "a".repeat(64), executable: true }],
      ...change,
    }),
  );
  return directory;
}

test("release metadata exposes the whole bundle's runtime and actual ELF library requirements", () => {
  const bundle = readBundle(metadataFile());
  expect(bundle.version).toBe("0.1.0");
  expect(bundle.systemLibraries).toEqual({ glibc: "2.36", glibcxx: "3.4.30", cxxabi: "1.3.13" });
});

test("release selection rejects latest and paths instead of silently selecting another version", () => {
  for (const version of ["latest", "v0.1.0", "../0.1.0", "0.1", "0.1.0/../../escape"])
    expect(() => releaseVersion.parse(version)).toThrow();
});

test("metadata cannot authenticate a file outside its complete bundle", () => {
  for (const path of ["../outside", "/outside", "app/../outside", "app//main.js", "bundle.json"])
    expect(() =>
      readBundle(metadataFile({ files: [{ path, sha256: "a".repeat(64), executable: false }] })),
    ).toThrow();
});

test("duplicate inventory entries are rejected rather than concealing missing bundle files", () => {
  const file = { path: "node/bin/node", sha256: "a".repeat(64), executable: true };
  expect(() => readBundle(metadataFile({ files: [file, file] }))).toThrow("duplicate");
});

test("unsupported platforms and unknown metadata formats do not become installable bundles", () => {
  for (const change of [
    { platform: "darwin" },
    { architecture: "ia32" },
    { format: 2 },
    { nodeVersion: "v22.0.0" },
  ])
    expect(() => readBundle(metadataFile(change))).toThrow();
});
