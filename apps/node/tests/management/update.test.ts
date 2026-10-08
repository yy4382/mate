import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { updateNode } from "../../src/management/update.js";
import { nodePaths } from "../../src/management/paths.js";
import { renderNodeUnit } from "../../src/management/service/unit.js";
import { type UserServiceManager } from "../../src/management/service/systemd.js";
import { withManagementLock } from "../../src/management/install-entry.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture(active = "active", sub = "running", pid = 42, job = 0) {
  const home = mkdtempSync(join(tmpdir(), "mate-update-command-"));
  homes.push(home);
  const paths = nodePaths(home);
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
  symlinkSync(join(paths.versionsDirectory, "0.1.0/bin/mate"), paths.entry);
  writeFileSync(paths.unit, renderNodeUnit(paths, "0.1.0"));
  const manager: UserServiceManager = {
    assertAvailable() {},
    inspect() {
      return {
        active,
        sub,
        pid,
        job,
        load: "loaded",
        enabled: "disabled",
        fragment: paths.unit,
        needsReload: false,
        type: "exec",
        execStart: [],
      };
    },
    run() {
      throw new Error("Update must not operate a running service");
    },
    linger() {
      return "no";
    },
    logs() {
      return 0;
    },
  };
  return { paths, manager };
}

test("update refuses a running or restarting service before acquiring a package or changing references", async () => {
  for (const [active, sub, pid, job] of [
    ["active", "running", 42, 0],
    ["activating", "auto-restart", 0, 0],
    ["inactive", "dead", 0, 7],
    ["deactivating", "stop-sigterm", 42, 0],
  ] satisfies Array<[string, string, number, number]>) {
    const { paths, manager } = fixture(active, sub, pid, job);
    const before = readFileSync(paths.unit, "utf8");
    await expect(
      updateNode({ version: "0.2.0", package: "/missing", sha256: "a".repeat(64) }, paths, manager),
    ).rejects.toThrow("stopped");
    expect(readFileSync(paths.unit, "utf8")).toBe(before);
  }
});

test("a local package checksum failure keeps the stopped entry, unit and saved data", async () => {
  const { paths, manager } = fixture("inactive", "dead", 0);
  const archive = join(paths.home, "not-a-package.tar.gz");
  writeFileSync(archive, "untrusted bytes");
  mkdirSync(paths.dataDirectory, { recursive: true });
  writeFileSync(join(paths.dataDirectory, "node-identity.json"), "original identity");
  const before = readFileSync(paths.unit, "utf8");
  await expect(
    updateNode({ version: "0.2.0", package: archive, sha256: "a".repeat(64) }, paths, manager),
  ).rejects.toThrow("SHA-256");
  expect(readFileSync(paths.unit, "utf8")).toBe(before);
  expect(readlinkSync(paths.entry)).toBe(join(paths.versionsDirectory, "0.1.0/bin/mate"));
  expect(readFileSync(join(paths.dataDirectory, "node-identity.json"), "utf8")).toBe(
    "original identity",
  );
});

test("another management operation holds the lock before update can acquire or alter references", async () => {
  const { paths, manager } = fixture("inactive", "dead", 0);
  await withManagementLock(paths, async () => {
    await expect(
      updateNode({ version: "0.2.0", package: "/missing", sha256: "a".repeat(64) }, paths, manager),
    ).rejects.toThrow("Another Mate management command");
  });
  expect(readlinkSync(paths.entry)).toBe(join(paths.versionsDirectory, "0.1.0/bin/mate"));
});

test("foreign units and entry files remain conflicts even when the old public CLI is broken", async () => {
  const { paths, manager } = fixture("inactive", "dead", 0);
  writeFileSync(paths.unit, "[Service]\nExecStart=/foreign\n");
  await expect(
    updateNode({ version: "0.2.0", package: "/missing", sha256: "a".repeat(64) }, paths, manager),
  ).rejects.toThrow("Non-Mate");
  expect(readFileSync(paths.unit, "utf8")).toContain("/foreign");
  writeFileSync(paths.unit, renderNodeUnit(paths, "0.1.0"));
  rmSync(paths.entry);
  writeFileSync(paths.entry, "foreign file");
  await expect(
    updateNode({ version: "0.2.0", package: "/missing", sha256: "a".repeat(64) }, paths, manager),
  ).rejects.toThrow("Non-Mate");
  expect(readFileSync(paths.entry, "utf8")).toBe("foreign file");
});
