import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it.each(["start", "local"])("blocks the legacy %s CLI before reading configuration", (command) => {
  const result = spawnSync(
    process.execPath,
    [resolve("dist/src/main.js"), command, "/does-not-exist/mate.json"],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Legacy daemon entry is disabled");
  expect(result.stderr).not.toContain("ENOENT");
});
