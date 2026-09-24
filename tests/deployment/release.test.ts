import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { assertSafeReleaseMode, createReleaseManifest } from "../../src/deployment/release.js";
import { isMainModule } from "../../src/main.js";
import { isDeploymentMainModule } from "../../src/deployment/cli.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const runtime = {
  platform: "linux" as const,
  arch: "x64",
  node: "v24.21.0",
  modulesAbi: "137",
  packageManager: "pnpm@10.33.0",
};
function release(): string {
  const root = mkdtempSync(join(tmpdir(), "mate-release-"));
  roots.push(root);
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "dist", "main.js"), "one");
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9");
  return root;
}
it("binds release identity to lockfile, runtime, dependency inventory and native addons", async () => {
  const root = release();
  mkdirSync(join(root, "node_modules", "pkg"));
  writeFileSync(join(root, "node_modules", "pkg", "addon.node"), "native");
  symlinkSync("pkg", join(root, "node_modules", "alias"));
  const first = await createReleaseManifest(root, "abcdef1234567", runtime);
  expect(first.nativeAddons).toHaveLength(1);
  expect(first.target).toMatchObject({ arch: "x64", node: "v24.21.0", modulesAbi: "137" });
  writeFileSync(join(root, "dist", "main.js"), "two");
  const second = await createReleaseManifest(root, "abcdef1234567", runtime);
  expect(second.releaseId).not.toBe(first.releaseId);
  symlinkSync("/tmp", join(root, "node_modules", "escape"));
  await expect(createReleaseManifest(root, "abcdef1234567", runtime)).rejects.toThrow("relative");
});
it("rejects privileged release modes before root-owned publication", async () => {
  expect(() => assertSafeReleaseMode(0o4755, "tool")).toThrow("setuid or setgid");
  expect(() => assertSafeReleaseMode(0o2755, "tool")).toThrow("setuid or setgid");
  const root = release(),
    tool = join(root, "node_modules", "tool");
  writeFileSync(tool, "tool");
  chmodSync(tool, 0o4755);
  if (lstatSync(tool).mode & 0o6000)
    await expect(createReleaseManifest(root, "abcdef1234567", runtime)).rejects.toThrow(
      "setuid or setgid",
    );
});
it("accepts pnpm-style hardlinks only when every link is inside the immutable release tree", async () => {
  const root = release();
  writeFileSync(join(root, "node_modules", "one.js"), "shared");
  linkSync(join(root, "node_modules", "one.js"), join(root, "node_modules", "two.js"));
  await expect(createReleaseManifest(root, "abcdef1234567", runtime)).resolves.toMatchObject({
    version: 1,
  });
  const outside = join(dirname(root), `${basename(root)}-outside`);
  writeFileSync(outside, "external");
  linkSync(outside, join(root, "node_modules", "outside.js"));
  await expect(createReleaseManifest(root, "abcdef1234567", runtime)).rejects.toThrow(
    "outside the immutable tree",
  );
  rmSync(outside, { force: true });
});
it("recognizes a deployed CLI reached through the current release symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "mate-main-link-"));
  roots.push(root);
  mkdirSync(join(root, "release"));
  const main = join(root, "release", "main.js");
  writeFileSync(main, "");
  symlinkSync(join(root, "release"), join(root, "current"));
  expect(
    isMainModule(join(root, "current", "main.js"), pathToFileURL(realpathSync(main)).href),
  ).toBe(true);
  expect(
    isDeploymentMainModule(
      join(root, "current", "main.js"),
      pathToFileURL(realpathSync(main)).href,
    ),
  ).toBe(true);
});
