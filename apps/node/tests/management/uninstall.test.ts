import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { uninstallNode } from "../../src/management/uninstall.js";
import { nodePaths } from "../../src/management/paths.js";
import { renderNodeUnit } from "../../src/management/service.js";
import type { UserServiceManager } from "../../src/management/systemd.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "mate-uninstall-"));
  homes.push(home);
  const paths = nodePaths(home),
    bundle = join(paths.versionsDirectory, "0.1.0");
  const inventory = [
    "bin/mate",
    "node/bin/node",
    "app/apps/node/dist/main.js",
    "app/apps/node/dist/management/cli.js",
    "app/apps/node/dist/files/rename-noreplace",
  ];
  const files = inventory.map((path) => {
    mkdirSync(dirname(join(bundle, path)), { recursive: true });
    writeFileSync(join(bundle, path), "synthetic-program");
    return {
      path,
      sha256: createHash("sha256").update("synthetic-program").digest("hex"),
      executable: false,
    };
  });
  writeFileSync(
    join(bundle, "bundle.json"),
    JSON.stringify({
      format: 1,
      version: "0.1.0",
      nodeVersion: "v24.21.0",
      platform: "linux",
      architecture: "arm64",
      buildSystem: { id: "debian", version: "12" },
      systemLibraries: { glibc: "2.34", glibcxx: "3.4.29", cxxabi: "1.3.11" },
      targetSystems: ["ubuntu:24.04", "debian:13"],
      files,
    }),
  );
  const recovery = join(home, "recovery");
  cpSync(bundle, recovery, { recursive: true });
  copyFileSync(
    fileURLToPath(new URL("../../dist/files/rename-noreplace", import.meta.url)),
    join(recovery, "app/apps/node/dist/files/rename-noreplace"),
  );
  copyFileSync(join(bundle, "bundle.json"), join(recovery, "bundle.json"));
  mkdirSync(dirname(paths.entry), { recursive: true });
  symlinkSync(join(bundle, "bin/mate"), paths.entry);
  mkdirSync(dirname(paths.unit), { recursive: true });
  writeFileSync(paths.unit, renderNodeUnit(paths, "0.1.0"));
  mkdirSync(paths.configDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    paths.configuration,
    JSON.stringify({ MATE_CONTROL_PLANE_URL: "http://127.0.0.1:8787" }),
    { mode: 0o600 },
  );
  mkdirSync(join(paths.dataDirectory, "agents"), { recursive: true });
  const retained = [
    paths.configuration,
    join(paths.dataDirectory, "node-identity.json"),
    join(paths.dataDirectory, "operations.sqlite"),
    join(paths.dataDirectory, "agents/MEMORY.md"),
  ];
  for (const file of retained.slice(1)) writeFileSync(file, "synthetic-retained-data");
  let loaded = true,
    active = "active",
    enabled = "enabled",
    fail = "";
  const manager: UserServiceManager = {
    assertAvailable() {},
    inspect() {
      return {
        load: loaded ? "loaded" : "not-found",
        active,
        sub: active === "active" ? "running" : "dead",
        enabled,
        pid: active === "active" ? 42 : 0,
        job: 0,
        fragment: loaded ? paths.unit : "",
        needsReload: false,
        type: "exec",
        execStart: [
          {
            path: join(bundle, "node/bin/node"),
            argv: [
              join(bundle, "node/bin/node"),
              join(bundle, "app/apps/node/dist/main.js"),
              "--config-file",
              paths.configuration,
            ],
            flags: ["no-env-expand"],
          },
        ],
      };
    },
    run(action) {
      if (action === fail) throw new Error(`synthetic ${action} failure`);
      if (action === "stop") active = "inactive";
      if (action === "disable") enabled = "disabled";
      if (action === "daemon-reload") loaded = existsSync(paths.unit);
    },
    linger() {
      return "no";
    },
    logs() {
      return 0;
    },
  };
  return {
    paths,
    bundle,
    recovery,
    retained,
    manager,
    setFailure(value: string) {
      fail = value;
    },
  };
}

test("uninstall removes only its service and program while preserving data, and a local CLI can repeat", async () => {
  const f = fixture(),
    before = f.retained.map((file) => readFileSync(file, "utf8"));
  const output = await uninstallNode(f.paths, f.recovery, f.manager);
  expect(f.manager.inspect()).toMatchObject({
    active: "inactive",
    enabled: "disabled",
    load: "not-found",
  });
  expect(existsSync(f.paths.entry)).toBe(false);
  expect(existsSync(f.bundle)).toBe(false);
  expect(f.retained.map((file) => readFileSync(file, "utf8"))).toEqual(before);
  expect(output).toContain("Preserved");
  await expect(uninstallNode(f.paths, f.recovery, f.manager)).resolves.toContain("already absent");
});

test("failed reload reports completed removal and a local bundle resumes without reinstalling", async () => {
  const f = fixture();
  f.setFailure("daemon-reload");
  await expect(uninstallNode(f.paths, f.recovery, f.manager)).rejects.toThrow(
    "Mate user unit removed",
  );
  expect(existsSync(f.bundle)).toBe(true);
  expect(existsSync(f.paths.unit)).toBe(false);
  f.setFailure("");
  await expect(uninstallNode(f.paths, f.recovery, f.manager)).resolves.toContain(
    "Program bundle removed",
  );
});

test("non-Mate program additions are preserved and reported, then partial inventory resumes after entry loss", async () => {
  const f = fixture(),
    foreign = join(f.bundle, "foreign.txt");
  writeFileSync(foreign, "foreign");
  await expect(uninstallNode(f.paths, f.recovery, f.manager)).rejects.toThrow("foreign.txt");
  expect(readFileSync(foreign, "utf8")).toBe("foreign");
  expect(existsSync(join(f.bundle, "node/bin/node"))).toBe(true);
  rmSync(foreign);
  rmSync(f.paths.entry);
  rmSync(join(f.bundle, "node/bin/node"));
  await expect(uninstallNode(f.paths, f.recovery, f.manager)).resolves.toContain(
    "Management entry already absent",
  );
  expect(existsSync(f.bundle)).toBe(false);
});

test("a foreign same-name unit and a regular public entry are never removed", async () => {
  const f = fixture();
  writeFileSync(f.paths.unit, "[Service]\nExecStart=/foreign\n");
  await expect(uninstallNode(f.paths, f.recovery, f.manager)).rejects.toThrow("Non-Mate");
  expect(f.manager.inspect().active).toBe("active");
  expect(readFileSync(f.paths.unit, "utf8")).toContain("/foreign");
  writeFileSync(f.paths.unit, renderNodeUnit(f.paths, "0.1.0"));
  rmSync(f.paths.entry);
  writeFileSync(f.paths.entry, "foreign-command");
  await expect(uninstallNode(f.paths, f.recovery, f.manager)).rejects.toThrow("Non-Mate");
  expect(readFileSync(f.paths.entry, "utf8")).toBe("foreign-command");
});

test("configured data inside removable programs blocks program deletion even after service cleanup", async () => {
  const f = fixture();
  writeFileSync(
    f.paths.configuration,
    JSON.stringify({
      MATE_CONTROL_PLANE_URL: "http://127.0.0.1:8787",
      MATE_NODE_DATA_DIR: join(f.bundle, "kept-data"),
    }),
  );
  await expect(uninstallNode(f.paths, f.recovery, f.manager)).rejects.toThrow("overlap");
  expect(existsSync(f.bundle)).toBe(true);
});

test("interrupted entry and unit removal files resume without a public management entry", async () => {
  const f = fixture(),
    unitStage = join(
      dirname(f.paths.unit),
      ".mate-removing-unit-12345678-1234-1234-1234-123456789abc",
    ),
    entryStage = join(
      dirname(f.paths.entry),
      ".mate-removing-12345678-1234-1234-1234-123456789abc",
    );
  f.manager.run("stop");
  f.manager.run("disable");
  writeFileSync(unitStage, readFileSync(f.paths.unit));
  rmSync(f.paths.unit);
  symlinkSync(join(f.bundle, "bin/mate"), entryStage);
  rmSync(f.paths.entry);
  await uninstallNode(f.paths, f.recovery, f.manager);
  expect(existsSync(unitStage)).toBe(false);
  expect(existsSync(entryStage)).toBe(false);
});

test("early manager failure reports configured retained locations without modifying service or data", async () => {
  const f = fixture(),
    data = join(f.paths.home, "custom-data"),
    workspace = join(f.paths.home, "custom-workspaces");
  writeFileSync(
    f.paths.configuration,
    JSON.stringify({
      MATE_CONTROL_PLANE_URL: "http://127.0.0.1:8787",
      MATE_NODE_DATA_DIR: data,
      MATE_NODE_AGENT_WORKSPACE_ROOT: workspace,
    }),
  );
  f.manager.assertAvailable = () => {
    throw new Error("User manager unavailable");
  };
  const attempt = uninstallNode(f.paths, f.recovery, f.manager);
  await expect(attempt).rejects.toThrow(join(data, "node-identity.json"));
  await expect(attempt).rejects.toThrow(workspace);
  await expect(attempt).rejects.toThrow("MATE_CONTROL_PLANE_DATA_DIR");
  expect(existsSync(f.paths.unit)).toBe(true);
  expect(existsSync(f.bundle)).toBe(true);
});

test("uninstall resumes an update's moved owned unit and incomplete installation without starting", async () => {
  const f = fixture(),
    backup = join(
      dirname(f.paths.unit),
      ".mate-node-previous-unit-12345678-1234-1234-1234-123456789abc",
    ),
    stage = join(f.paths.versionsDirectory, ".install-12345678-1234-1234-1234-123456789abc");
  writeFileSync(backup, readFileSync(f.paths.unit));
  rmSync(f.paths.unit);
  mkdirSync(stage);
  writeFileSync(join(stage, ".mate-install-stage"), "Mate node bootstrap staging\n", {
    mode: 0o600,
  });
  mkdirSync(join(stage, "app/apps/node/dist"), { recursive: true });
  writeFileSync(join(stage, "app/apps/node/dist/main.js"), "synthetic-");
  const run = f.manager.run;
  f.manager.run = (action) => {
    if (action === "disable" && !existsSync(f.paths.unit))
      throw new Error("Missing unit cannot disable");
    if (action === "start" || action === "enable")
      throw new Error("Uninstall cannot start or enable");
    run(action);
  };
  await expect(uninstallNode(f.paths, f.recovery, f.manager)).resolves.toContain(
    "User service disabled",
  );
  expect(existsSync(backup)).toBe(false);
  expect(existsSync(stage)).toBe(false);
});

test("a valid installation marker never authorizes deleting an extra unknown file", async () => {
  const f = fixture(),
    stage = join(f.paths.versionsDirectory, ".install-12345678-1234-1234-1234-123456789abc");
  mkdirSync(stage);
  writeFileSync(join(stage, ".mate-install-stage"), "Mate node bootstrap staging\n", {
    mode: 0o600,
  });
  writeFileSync(join(stage, "non-mate-fixture"), "private non-Mate file");
  await expect(uninstallNode(f.paths, f.recovery, f.manager)).rejects.toThrow(
    "Unknown interrupted installation",
  );
  expect(readFileSync(join(stage, "non-mate-fixture"), "utf8")).toBe("private non-Mate file");
});

test.each(["directory", "link", "contents"])(
  "uninstall preserves an installation marker conflict (%s) and reports it",
  async (kind) => {
    const f = fixture(),
      stage = join(f.paths.versionsDirectory, ".install-12345678-1234-1234-1234-123456789abc"),
      marker = join(stage, ".mate-install-stage");
    cpSync(f.bundle, stage, { recursive: true });
    if (kind === "directory") mkdirSync(marker);
    else if (kind === "link") symlinkSync(f.paths.configuration, marker);
    else writeFileSync(marker, "non-Mate marker contents");
    await expect(uninstallNode(f.paths, f.recovery, f.manager)).rejects.toThrow(
      "Unknown interrupted installation marker preserved",
    );
    expect(lstatSync(marker).isDirectory()).toBe(kind === "directory");
    expect(lstatSync(marker).isSymbolicLink()).toBe(kind === "link");
    if (kind === "contents") expect(readFileSync(marker, "utf8")).toBe("non-Mate marker contents");
    expect(existsSync(join(stage, "bundle.json"))).toBe(true);
    expect(existsSync(f.bundle)).toBe(true);
  },
);

test("uninstall cleans a damaged repair backup only with the verified package inventory and preserves unknown repair files", async () => {
  const f = fixture(),
    backup = join(f.paths.versionsDirectory, ".repair-12345678-1234-1234-1234-123456789abc");
  cpSync(f.bundle, backup, { recursive: true });
  writeFileSync(join(backup, "app/apps/node/dist/main.js"), "damaged known program");
  writeFileSync(join(backup, "unknown.txt"), "non-Mate");
  await expect(uninstallNode(f.paths, f.recovery, f.manager)).rejects.toThrow("Unknown file");
  expect(readFileSync(join(backup, "unknown.txt"), "utf8")).toBe("non-Mate");
  rmSync(join(backup, "unknown.txt"));
  await uninstallNode(f.paths, f.recovery, f.manager);
  expect(existsSync(backup)).toBe(false);
});
