import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { releaseDigest } from "../../src/deployment/dual-installer.js";

it("changes release identity when installed dependency bytes change under the same lockfile", () => {
  const root = mkdtempSync(join(tmpdir(), "mate-release-identity-"));
  try {
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    writeFileSync(join(root, "dist", "main.js"), "export {};");
    writeFileSync(join(root, "node_modules", "runtime.js"), "export const value = 1;");
    const first = releaseDigest(root);
    writeFileSync(join(root, "node_modules", "runtime.js"), "export const value = 2;");
    expect(releaseDigest(root)).not.toBe(first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
