import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { nodePaths } from "../../src/management/paths.js";
import { manageNode, renderNodeUnit } from "../../src/management/service.js";
import type { UserServiceManager } from "../../src/management/systemd.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "mate-service-command-"));
  directories.push(home);
  const paths = nodePaths(home),
    bundle = join(paths.versionsDirectory, "0.1.0");
  mkdirSync(bundle, { recursive: true });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  mkdirSync(join(bundle, "app/apps/node/dist/files"), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL("../../dist/files/rename-noreplace", import.meta.url)),
    join(bundle, "app/apps/node/dist/files/rename-noreplace"),
  );
  symlinkSync(join(bundle, "bin/mate"), paths.entry);
  mkdirSync(paths.configDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    paths.configuration,
    JSON.stringify({
      MATE_CONTROL_PLANE_URL: "http://127.0.0.1:8787",
      MATE_NODE_PAIRING_TOKEN: "synthetic-pairing-token".repeat(2),
    }),
    { mode: 0o600 },
  );
  let active = "inactive",
    enabled = "disabled",
    pid = 0,
    available = true;
  const manager: UserServiceManager = {
    assertAvailable() {
      if (!available) throw new Error("User manager unavailable");
    },
    inspect() {
      return {
        load: (() => {
          try {
            readFileSync(paths.unit);
            return "loaded";
          } catch {
            return "not-found";
          }
        })(),
        active,
        sub: active === "active" ? "running" : "dead",
        enabled,
        pid,
        job: 0,
        fragment: active === "missing" ? "/foreign.service" : paths.unit,
        needsReload: false,
        type: "exec",
        execStart: [
          {
            path: `${bundle}/node/bin/node`,
            flags: ["no-env-expand"],
            argv: [
              `${bundle}/node/bin/node`,
              `${bundle}/app/apps/node/dist/main.js`,
              "--config-file",
              paths.configuration,
            ],
          },
        ],
      };
    },
    run(action) {
      if (action === "start" || action === "restart") {
        active = "active";
        pid += 1;
      }
      if (action === "stop") active = "inactive";
      if (action === "enable") enabled = "enabled";
      if (action === "disable") enabled = "disabled";
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
    manager,
    unavailable() {
      available = false;
    },
  };
}

test("first install starts a single service, while repeating preserves stopped and disabled facts", async () => {
  const { paths, bundle, manager } = fixture();
  const before = readFileSync(paths.configuration, "utf8");
  await manageNode("install", paths, bundle, "0.1.0", manager);
  expect(manager.inspect()).toMatchObject({ active: "active", enabled: "enabled", pid: 1 });
  await manageNode("install", paths, bundle, "0.1.0", manager);
  expect(manager.inspect().pid).toBe(1);
  manager.run("stop");
  manager.run("disable");
  await manageNode("install", paths, bundle, "0.1.0", manager);
  expect(manager.inspect()).toMatchObject({ active: "inactive", enabled: "disabled", pid: 1 });
  expect(readFileSync(paths.configuration, "utf8")).toBe(before);
  const unit = readFileSync(paths.unit, "utf8");
  expect(unit).toContain(
    `ExecStart=:"${bundle}/node/bin/node" "${bundle}/app/apps/node/dist/main.js" --config-file "${paths.configuration}"`,
  );
  expect(unit).not.toContain("synthetic-pairing-token");
});

test("data remains separate even when its directory name starts with two dots", async () => {
  const { paths, bundle, manager } = fixture();
  writeFileSync(
    paths.configuration,
    JSON.stringify({
      MATE_CONTROL_PLANE_URL: "http://127.0.0.1:8787",
      MATE_NODE_PAIRING_TOKEN: "synthetic-pairing-token".repeat(2),
      MATE_NODE_DATA_DIR: join(paths.programDirectory, "..data"),
    }),
  );
  await expect(manageNode("install", paths, bundle, "0.1.0", manager)).rejects.toThrow("separate");
});

test("an ancestor symlink cannot place retained node data inside the removable program tree", async () => {
  const { paths, bundle, manager } = fixture();
  symlinkSync(paths.programDirectory, join(paths.home, "alias"), "dir");
  mkdirSync(join(paths.programDirectory, "data"), { mode: 0o700 });
  writeFileSync(
    paths.configuration,
    JSON.stringify({
      MATE_CONTROL_PLANE_URL: "http://127.0.0.1:8787",
      MATE_NODE_PAIRING_TOKEN: "synthetic-pairing-token".repeat(2),
      MATE_NODE_DATA_DIR: join(paths.home, "alias/data"),
    }),
  );
  await expect(manageNode("install", paths, bundle, "0.1.0", manager)).rejects.toThrow("separate");
});

test("a manager drop-in cannot silently replace the effective node command or configuration", async () => {
  const { paths, bundle, manager } = fixture();
  await manageNode("install", paths, bundle, "0.1.0", manager);
  const inspect = manager.inspect;
  manager.inspect = () => ({
    ...inspect(),
    execStart: [{ path: "/foreign", argv: ["/foreign"], flags: ["no-env-expand"] }],
  });
  await expect(manageNode("status", paths, bundle, "0.1.0", manager)).rejects.toThrow(
    "references differ",
  );
  await expect(manageNode("start", paths, bundle, "0.1.0", manager)).rejects.toThrow("references");
  await expect(manageNode("stop", paths, bundle, "0.1.0", manager)).resolves.toContain(
    "Active: inactive",
  );
});

test("stopping remains possible with damaged configuration and reports that the stop completed", async () => {
  const { paths, bundle, manager } = fixture();
  await manageNode("install", paths, bundle, "0.1.0", manager);
  chmodSync(paths.configuration, 0o644);
  await expect(manageNode("stop", paths, bundle, "0.1.0", manager)).rejects.toThrow(
    "stop completed",
  );
  expect(manager.inspect().active).toBe("inactive");
});

test("stop and logs remain available when effective command inspection fails", async () => {
  const { paths, bundle, manager } = fixture();
  await manageNode("install", paths, bundle, "0.1.0", manager);
  const inspect = manager.inspect;
  // A malformed foreign command or unavailable typed transport must not block recovery.
  manager.inspect = (options?: { effectiveCommand?: boolean }) => {
    if (options?.effectiveCommand !== false) throw new Error("Effective command is unknown");
    return { ...inspect(), execStart: [] };
  };
  await expect(manageNode("start", paths, bundle, "0.1.0", manager)).rejects.toThrow("unknown");
  await expect(manageNode("status", paths, bundle, "0.1.0", manager)).rejects.toThrow("unknown");
  await expect(manageNode("stop", paths, bundle, "0.1.0", manager)).resolves.toContain(
    "Active: inactive",
  );
  await expect(manageNode("logs", paths, bundle, "0.1.0", manager)).resolves.toBe("");
});

test("a drop-in with the same argv cannot restore environment substitution or change execution acknowledgement", async () => {
  const { paths, bundle, manager } = fixture();
  await manageNode("install", paths, bundle, "0.1.0", manager);
  const inspect = manager.inspect;
  manager.inspect = () => ({
    ...inspect(),
    execStart: inspect().execStart.map((entry) => ({ ...entry, flags: [] })),
  });
  await expect(manageNode("start", paths, bundle, "0.1.0", manager)).rejects.toThrow("references");
  manager.inspect = () => ({ ...inspect(), type: "simple" });
  await expect(manageNode("start", paths, bundle, "0.1.0", manager)).rejects.toThrow("references");
});

test("interrupted installation with an existing stopped unit only reloads and reports explicit start", async () => {
  const { paths, bundle, manager } = fixture();
  mkdirSync(join(paths.home, ".config/systemd/user"), { recursive: true });
  writeFileSync(paths.unit, renderNodeUnit(paths, "0.1.0"));
  const report = await manageNode("install", paths, bundle, "0.1.0", manager);
  expect(manager.inspect()).toMatchObject({ active: "inactive", enabled: "disabled" });
  expect(report).toContain("mate node start");
});

test("missing manager and foreign unit fail before replacing files or reporting stopped", async () => {
  const { paths, bundle, manager, unavailable } = fixture();
  mkdirSync(join(paths.home, ".config/systemd/user"), { recursive: true });
  writeFileSync(paths.unit, "[Service]\nExecStart=/foreign\n");
  await expect(manageNode("install", paths, bundle, "0.1.0", manager)).rejects.toThrow("Non-Mate");
  expect(readFileSync(paths.unit, "utf8")).toContain("/foreign");
  unavailable();
  await expect(manageNode("status", paths, bundle, "0.1.0", manager)).rejects.toThrow("manager");
});

test("status reports actual facts without a pairing token, and refuses mismatched installed references", async () => {
  const { paths, bundle, manager } = fixture();
  await manageNode("install", paths, bundle, "0.1.0", manager);
  const output = await manageNode("status", paths, bundle, "0.1.0", manager);
  expect(output).toContain("Active: active");
  expect(output).toContain("does not establish pairing or online");
  expect(output).not.toContain("synthetic-pairing-token");
  writeFileSync(paths.unit, renderNodeUnit(paths, "0.2.0"));
  await expect(manageNode("status", paths, bundle, "0.1.0", manager)).rejects.toThrow(
    "references differ",
  );
  await expect(manageNode("start", paths, bundle, "0.1.0", manager)).rejects.toThrow("references");
});

test("interrupted private unit staging is retried but unknown files are preserved", async () => {
  const { paths, bundle, manager } = fixture();
  mkdirSync(join(paths.home, ".config/systemd/user"), { recursive: true });
  const interrupted = join(
    join(paths.home, ".config/systemd/user"),
    ".mate-node-unit-12345678-1234-1234-1234-123456789abc",
  );
  writeFileSync(interrupted, "# Mate node service\n", { mode: 0o600 });
  await manageNode("install", paths, bundle, "0.1.0", manager);
  expect(() => readFileSync(interrupted)).toThrow();
  writeFileSync(interrupted, "foreign-file", { mode: 0o600 });
  await expect(manageNode("install", paths, bundle, "0.1.0", manager)).rejects.toThrow("preserved");
  expect(readFileSync(interrupted, "utf8")).toBe("foreign-file");
});
