import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeploymentMainModule } from "../../src/deployment/cli.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("recognizes the deployment CLI through the current release symlink", () => {
  const root = mkdtempSync(join(tmpdir(), "mate-deployment-entrypoint-"));
  roots.push(root);
  mkdirSync(join(root, "release"));
  const entry = join(root, "release", "cli.js");
  writeFileSync(entry, "");
  symlinkSync(join(root, "release"), join(root, "current"));

  expect(
    isDeploymentMainModule(
      join(root, "current", "cli.js"),
      pathToFileURL(realpathSync(entry)).href,
    ),
  ).toBe(true);
});
