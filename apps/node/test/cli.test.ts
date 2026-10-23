import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { host, serviceChanges, snapshot, writeBundle, type Host } from "./cli-support.ts";
import { eventually } from "./support.ts";

const program = (h: Host) => h.paths.program;
const unit = (h: Host) => h.paths.unit;
const command = (h: Host) => h.paths.command;
const config = (h: Host) => h.paths.config;
const installedVersion = (h: Host) =>
  JSON.parse(readFileSync(join(program(h), "manifest.json"), "utf8")).version;
/** Mate's scratch directories next to the program directory (DEPLOYMENT §3.2). */
const scratch = (h: Host) =>
  readdirSync(dirname(h.paths.program)).filter((name) => name.startsWith(".mate-node-"));

function expectCommand(h: Host): void {
  if (process.platform === "win32") {
    expect(statSync(command(h)).isFile()).toBe(true);
    expect(readFileSync(command(h), "utf8")).toContain("%~dp0..\\program\\bin\\mate.cmd");
  } else {
    expect(readlinkSync(command(h))).toBe(join(program(h), "bin/mate"));
  }
}

function ok(h: Host, ...args: string[]): string {
  const result = h.mate(...args);
  expect(result.status, `mate ${args.join(" ")}: ${result.stderr}`).toBe(0);
  return result.stdout;
}

function refused(h: Host, ...args: string[]): string {
  const result = h.mate(...args);
  expect(result.status, `mate ${args.join(" ")} should refuse: ${result.stdout}`).toBe(1);
  return result.stderr;
}

/** Installed, configured, with an identity and a workspace, and started once, the way an owner's node looks. */
function runningNode(version = "1.0.0"): Host {
  const h = host();
  ok(h, "node", "install", writeBundle(h.inputs, { version }));
  ok(
    h,
    "node",
    "configure",
    "--control-plane",
    "http://127.0.0.1:8787",
    "--pairing-token",
    "secret-pairing-token",
  );
  mkdirSync(h.paths.data, { recursive: true });
  writeFileSync(join(h.paths.data, "node-identity.json"), "identity\n");
  mkdirSync(join(h.paths.workspaces, "agent-1"), { recursive: true });
  writeFileSync(join(h.paths.workspaces, "agent-1/MEMORY.md"), "remember this\n");
  ok(h, "node", "start");
  return h;
}

/** The files install, update and uninstall must never touch. */
const agentData = (h: Host) => [
  readFileSync(config(h), "utf8"),
  ...snapshot(h.paths.data),
  ...snapshot(join(h.home, "mate")),
];

describe("mate node CLI (MODULE_TESTS 9)", () => {
  it("install puts the program, the mate command and the unit in place without starting anything, and start then enables and starts the service", () => {
    const h = host();
    const out = ok(h, "node", "install", writeBundle(h.inputs, { version: "1.0.0" }));
    expect(installedVersion(h)).toBe("1.0.0");
    expectCommand(h);
    const bytes = readFileSync(unit(h));
    const definition = bytes.toString(process.platform === "win32" ? "utf16le" : "utf8");
    if (process.platform === "win32") {
      expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
      expect(definition).toContain('encoding="UTF-16"');
    }
    expect(definition).toContain("mate.mjs");
    expect(definition).toContain("--service");
    expect(serviceChanges(h), "install never starts or enables").toEqual([]);
    expect(out, "install tells the owner what is left to do").toContain("mate node configure");

    expect(refused(h, "node", "start"), "start needs a config").toContain("configure");
    expect(serviceChanges(h)).toEqual([]);
    ok(h, "node", "configure", "--control-plane", "http://127.0.0.1:8787", "--pairing-token", "t");
    ok(h, "node", "start");
    expect(h.service()).toMatchObject({ active: "active", enabled: "enabled" });
  });

  it("install again changes nothing and never starts, restarts or re-enables the service, whether it runs or the owner stopped it", () => {
    const h = runningNode();
    const bundle = join(h.inputs, "mate-node-1.0.0.tar.gz");
    const before = snapshot(h.home);
    h.setService({ calls: [] });
    ok(h, "node", "install", bundle);
    expect(serviceChanges(h), "a running service is left running").toEqual([]);
    expect(snapshot(h.home)).toEqual(before);

    ok(h, "node", "stop");
    expect(h.service()).toMatchObject({ active: "inactive", enabled: "disabled" });
    h.setService({ calls: [] });
    ok(h, "node", "install", bundle);
    ok(h, "node", "install", bundle);
    expect(serviceChanges(h), "a stopped service stays stopped").toEqual([]);
    expect(h.service()).toMatchObject({ active: "inactive", enabled: "disabled" });
  });

  it("install refuses a bundle of another version than the installed one and changes nothing", () => {
    const h = runningNode("1.0.0");
    const before = snapshot(h.home);
    expect(refused(h, "node", "install", writeBundle(h.inputs, { version: "2.0.0" }))).toContain(
      "mate node update",
    );
    expect(snapshot(h.home)).toEqual(before);
  });

  it.each(["active", "activating", "deactivating", "reloading", "unknown"])(
    "update refuses while the service is %s and changes nothing",
    (active) => {
      const h = runningNode();
      h.setService({ active, calls: [] });
      const before = snapshot(h.home);
      expect(refused(h, "node", "update", writeBundle(h.inputs, { version: "2.0.0" }))).toContain(
        "mate node stop",
      );
      expect(snapshot(h.home)).toEqual(before);
      expect(serviceChanges(h)).toEqual([]);
    },
  );

  it.runIf(process.platform !== "linux")(
    "update refuses an enabled service with no current process until it is explicitly stopped",
    () => {
      const h = runningNode();
      h.setService({ active: "inactive", mainPid: 0, calls: [] });
      const before = snapshot(h.home);
      expect(refused(h, "node", "update", writeBundle(h.inputs, { version: "2.0.0" }))).toContain(
        "mate node stop",
      );
      expect(snapshot(h.home)).toEqual(before);
      expect(serviceChanges(h)).toEqual([]);
    },
  );

  it("refuses to install into or remove a program directory without a Mate manifest", () => {
    const h = host();
    mkdirSync(program(h), { recursive: true });
    writeFileSync(join(program(h), "my-program.txt"), "keep this");
    const before = snapshot(h.home);
    const bundle = writeBundle(h.inputs, { version: "1.0.0" });
    for (const args of [["install", bundle], ["update", bundle], ["uninstall"]]) {
      expect(refused(h, "node", ...args)).toContain("no Mate manifest");
      expect(snapshot(h.home)).toEqual(before);
    }
    expect(h.service().calls).toEqual([]);
  });

  it("update replaces the program while the service is stopped, keeps it stopped, and leaves config, identity and workspaces untouched", () => {
    const h = runningNode("1.0.0");
    ok(h, "node", "stop");
    const data = agentData(h);
    h.setService({ calls: [] });
    ok(h, "node", "update", writeBundle(h.inputs, { version: "2.0.0" }));
    expect(installedVersion(h)).toBe("2.0.0");
    expect(readFileSync(join(program(h), "lib/mate.mjs"), "utf8")).toBe("// mate 2.0.0\n");
    expectCommand(h);
    expect(serviceChanges(h), "update never starts the service").toEqual([]);
    expect(h.service().active).toBe("inactive");
    expect(agentData(h)).toEqual(data);
    expect(scratch(h)).toEqual([]);
  });

  it("an update that died between moving the old program aside and placing the new one completes when run again", () => {
    const h = runningNode("1.0.0");
    ok(h, "node", "stop");
    const data = agentData(h);
    const lib = dirname(h.paths.program);
    mkdirSync(join(lib, ".mate-node-old-abc123"));
    renameSync(program(h), join(lib, ".mate-node-old-abc123/program"));
    mkdirSync(join(lib, ".mate-node-staging-def456/lib"), { recursive: true });
    writeFileSync(join(lib, ".mate-node-staging-def456/lib/mate.mjs"), "// half\n");

    ok(h, "node", "update", writeBundle(h.inputs, { version: "2.0.0" }));
    expect(installedVersion(h)).toBe("2.0.0");
    expect(scratch(h)).toEqual([]);
    expect(agentData(h)).toEqual(data);
  });

  it("an update killed while checking or unpacking the bundle leaves the installed program as it was, and running it again completes", async () => {
    const h = runningNode("1.0.0");
    ok(h, "node", "stop");
    const installed = snapshot(program(h));
    const bundle = writeBundle(h.inputs, { version: "2.0.0", bigFileBytes: 64 * 1024 * 1024 });
    const { child, closed } = h.spawnMate("node", "update", bundle);
    await eventually(() => scratch(h).length > 0, "update starts unpacking", 10_000);
    child.kill("SIGKILL");
    await closed;
    expect(snapshot(program(h)), "the killed run left the old program whole").toEqual(installed);

    ok(h, "node", "update", bundle);
    expect(installedVersion(h)).toBe("2.0.0");
    expect(scratch(h)).toEqual([]);
  });

  it("uninstall stops the service and removes the program, the command and the unit, keeps config, identity and workspaces, and finds nothing to do when run again", () => {
    const h = runningNode();
    const data = agentData(h);
    ok(h, "node", "uninstall");
    expect(h.service()).toMatchObject({ active: "inactive", enabled: "disabled" });
    expect(existsSync(program(h))).toBe(false);
    expect(existsSync(command(h))).toBe(false);
    expect(existsSync(unit(h))).toBe(false);
    expect(agentData(h)).toEqual(data);

    const after = snapshot(h.home);
    expect(ok(h, "node", "uninstall")).toContain("nothing to remove");
    expect(snapshot(h.home)).toEqual(after);
  });

  it.each([
    [
      "after removing the unit",
      (h: Host) => {
        ok(h, "node", "stop");
        rmSync(unit(h));
      },
    ],
    [
      "while deleting the program",
      (h: Host) => {
        ok(h, "node", "stop");
        rmSync(unit(h));
        rmSync(command(h));
        const old = join(dirname(h.paths.program), ".mate-node-old-abc123");
        mkdirSync(old);
        renameSync(program(h), join(old, "program"));
        rmSync(join(old, "program/lib"), { recursive: true });
      },
    ],
  ])("an uninstall that died %s completes when run again", (_, interrupt) => {
    const h = runningNode();
    const data = agentData(h);
    interrupt(h);
    ok(h, "node", "uninstall");
    expect(existsSync(program(h))).toBe(false);
    expect(existsSync(command(h))).toBe(false);
    expect(existsSync(unit(h))).toBe(false);
    expect(scratch(h)).toEqual([]);
    expect(agentData(h)).toEqual(data);
  });

  it("update and uninstall refuse when the program directory holds files Mate did not install, name them, and change nothing", () => {
    const h = runningNode();
    ok(h, "node", "stop");
    writeFileSync(join(program(h), "notes.txt"), "mine\n");
    mkdirSync(join(program(h), "lib/plugins"));
    const before = snapshot(h.home);
    for (const args of [
      ["node", "update", writeBundle(h.inputs, { version: "2.0.0" })],
      ["node", "uninstall"],
    ]) {
      const error = refused(h, ...args);
      expect(error).toContain("notes.txt");
      expect(error).toContain("lib/plugins");
      expect(snapshot(h.home)).toEqual(before);
    }
    expect(ok(h, "node", "status"), "status reports them too").toContain("notes.txt");
  });

  it("install and uninstall leave a unit file and a mate command that are not Mate's alone and report them", () => {
    const h = host();
    mkdirSync(dirname(h.paths.unit), { recursive: true });
    writeFileSync(unit(h), "[Service]\nExecStart=/opt/my-own-node\n");
    mkdirSync(dirname(h.paths.command), { recursive: true });
    writeFileSync(command(h), "#!/bin/sh\necho my own mate\n");
    const theirs = () => [readFileSync(unit(h), "utf8"), readFileSync(command(h), "utf8")];
    const before = theirs();

    const installed = ok(h, "node", "install", writeBundle(h.inputs, { version: "1.0.0" }));
    expect(installed).toContain(unit(h));
    expect(installed).toContain(command(h));
    expect(theirs()).toEqual(before);
    const callsBefore = h.service().calls.length;
    const removed = ok(h, "node", "uninstall");
    expect(removed).toContain(unit(h));
    expect(removed).toContain(command(h));
    expect(theirs()).toEqual(before);
    const calls = h.service().calls.slice(callsBefore);
    h.setService({ calls });
    expect(serviceChanges(h), "uninstall never changes a service Mate did not define").toEqual([]);
    expect(existsSync(program(h))).toBe(false);
  });

  it("install, update and uninstall refuse without a user manager and change nothing", () => {
    const h = runningNode();
    ok(h, "node", "stop");
    h.setService({ available: false });
    const before = snapshot(h.home);
    for (const args of [
      ["node", "install", join(h.inputs, "mate-node-1.0.0.tar.gz")],
      ["node", "update", writeBundle(h.inputs, { version: "2.0.0" })],
      ["node", "uninstall"],
    ]) {
      expect(refused(h, ...args)).toContain("user manager");
      expect(snapshot(h.home)).toEqual(before);
    }
  });

  it("leaves a foreign service loaded under Mate's name alone, even when the local definition is Mate's", () => {
    const h = runningNode();
    h.setService({ foreignDefinition: true, calls: [] });
    const definition = readFileSync(unit(h), "utf8");
    expect(refused(h, "node", "stop")).toContain("left alone");
    expect(refused(h, "node", "start")).toContain("left alone");
    ok(h, "node", "install", join(h.inputs, "mate-node-1.0.0.tar.gz"));
    ok(h, "node", "uninstall");
    expect(readFileSync(unit(h), "utf8")).toBe(definition);
    expect(h.service()).toMatchObject({ active: "active", enabled: "enabled" });
    expect(serviceChanges(h)).toEqual([]);
  });

  it.runIf(process.platform === "win32")(
    "refuses to stop or uninstall a running Windows task whose process identity cannot be verified",
    () => {
      const h = runningNode();
      h.setService({ unverifiedProcess: true, calls: [] });
      expect(refused(h, "node", "stop")).toContain("could not be verified");
      expect(refused(h, "node", "uninstall")).toContain("could not be verified");
      expect(installedVersion(h)).toBe("1.0.0");
      expect(h.service()).toMatchObject({ active: "active", enabled: "disabled" });
      expect(h.service().calls.some((call) => call[0] === "taskkill" || call[1] === "/End")).toBe(
        false,
      );
    },
  );

  it.runIf(process.platform === "win32")(
    "stop kills the process tree when a queued task starts after disabling it",
    () => {
      const h = runningNode();
      h.setService({ active: "activating", queuedReads: 2, calls: [] });
      ok(h, "node", "stop");
      expect(h.service()).toMatchObject({ active: "inactive", enabled: "disabled" });
      const calls = h.service().calls;
      const killed = calls.findIndex((call) => call[0] === "taskkill");
      const ended = calls.findIndex((call) => call[0] === "schtasks" && call[1] === "/End");
      expect(killed).toBeGreaterThan(-1);
      expect(ended).toBeGreaterThan(killed);
    },
  );

  it.runIf(process.platform === "win32")("updates an older Mate launcher", () => {
    const h = runningNode();
    ok(h, "node", "stop");
    writeFileSync(command(h), "@echo off\r\nrem Written by mate node.\r\necho old launcher\r\n");
    ok(h, "node", "update", writeBundle(h.inputs, { version: "2.0.0" }));
    expectCommand(h);
    expect(readFileSync(command(h), "utf8")).not.toContain("echo old launcher");
  });

  const canMapRoot = spawnSync("unshare", ["-r", "true"]).status === 0;
  it.runIf(canMapRoot || process.env["MATE_REQUIRE_PID_NAMESPACE"] === "1")(
    "management commands refuse to run as root",
    () => {
      const h = host();
      const bundle = writeBundle(h.inputs, { version: "1.0.0" });
      for (const args of [
        ["node", "install", bundle],
        ["node", "start"],
        ["node", "uninstall"],
      ]) {
        const result = spawnSync("unshare", ["-r", ...h.argv(...args)], {
          env: h.env,
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("root");
      }
      expect(snapshot(h.home)).toEqual([]);
      expect(h.service().calls).toEqual([]);
    },
  );

  it("configure writes a private config, and writing it again without a pairing token drops the token", () => {
    const h = host();
    ok(h, "node", "configure", "--control-plane", "https://mate.example", "--pairing-token", "t1");
    if (process.platform !== "win32") expect(statSync(config(h)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(config(h), "utf8"))).toEqual({
      controlPlaneUrl: "https://mate.example",
      workspacesRoot: join(h.home, "mate/workspaces"),
      pairingToken: "t1",
    });
    ok(h, "node", "configure", "--control-plane", "https://mate.example", "--workspaces", "ws");
    expect(JSON.parse(readFileSync(config(h), "utf8"))).toEqual({
      controlPlaneUrl: "https://mate.example",
      workspacesRoot: join(h.inputs, "ws"),
    });

    const before = readFileSync(config(h), "utf8");
    refused(h, "node", "configure", "--control-plane", "ftp://mate.example");
    expect(readFileSync(config(h), "utf8")).toBe(before);
  });

  it("status reports the version, the service and the config without printing the pairing token", () => {
    const h = runningNode("1.2.3");
    const out = ok(h, "node", "status");
    expect(out).toContain("1.2.3");
    expect(out).toContain("enabled");
    expect(out).toContain("http://127.0.0.1:8787");
    expect(out).not.toContain("secret-pairing-token");
  });

  it("logs reads the service's journal, and follows it when asked", () => {
    const h = runningNode();
    mkdirSync(h.paths.data, { recursive: true });
    writeFileSync(join(h.paths.data, "node.log"), "a journal line\n");
    expect(ok(h, "node", "logs")).toContain("a journal line");
    ok(h, "node", "logs", "--follow", "--lines", "20");
    const [plain, following] = h.service().journal;
    expect(plain).toBeDefined();
    expect(following).toBeDefined();
    const followed = following!.join(" ");
    expect(followed).toContain(
      process.platform === "linux" ? "--follow" : process.platform === "darwin" ? "-f" : "-Wait",
    );
  });

  it("node run without a config exits with a status the service unit does not restart", () => {
    const h = host();
    ok(h, "node", "install", writeBundle(h.inputs, { version: "1.0.0" }));
    const result = h.mate("node", "run");
    expect(result.stderr).toContain("configure");
    expect(result.status).toBe(78);
    const serviceResult = h.mate("node", "run", "--service");
    if (process.platform === "linux") {
      const noRestart = /^RestartPreventExitStatus=(.+)$/m.exec(readFileSync(unit(h), "utf8"))?.[1];
      expect(noRestart?.split(" ")).toContain(String(serviceResult.status));
    } else {
      expect(serviceResult.status).toBe(0);
      if (process.platform === "win32")
        expect(readFileSync(join(h.paths.data, "node.log"), "utf8")).toContain("configure");
    }
  });
});
