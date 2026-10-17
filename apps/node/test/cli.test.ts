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
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { host, snapshot, writeBundle, type Host } from "./cli-support.ts";
import { eventually } from "./support.ts";

const program = (h: Host) => join(h.home, ".local/lib/mate-node");
const unit = (h: Host) => join(h.home, ".config/systemd/user/mate-node.service");
const command = (h: Host) => join(h.home, ".local/bin/mate");
const config = (h: Host) => join(h.home, ".config/mate/node.json");
const installedVersion = (h: Host) =>
  JSON.parse(readFileSync(join(program(h), "manifest.json"), "utf8")).version;
/** Mate's scratch directories next to the program directory (DEPLOYMENT §5.4). */
const scratch = (h: Host) =>
  readdirSync(join(h.home, ".local/lib")).filter((name) => name.startsWith(".mate-node-"));
const verbs = (h: Host) => h.systemd().calls.map((call) => call[1]);
const serviceChanges = (h: Host) =>
  verbs(h).filter((verb) => verb !== "show" && verb !== "daemon-reload");

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
  mkdirSync(join(h.home, ".local/share/mate/node"), { recursive: true });
  writeFileSync(join(h.home, ".local/share/mate/node/node-identity.json"), "identity\n");
  mkdirSync(join(h.home, "mate/workspaces/agent-1"), { recursive: true });
  writeFileSync(join(h.home, "mate/workspaces/agent-1/MEMORY.md"), "remember this\n");
  ok(h, "node", "start");
  return h;
}

/** The files install, update and uninstall must never touch. */
const agentData = (h: Host) => [
  readFileSync(config(h), "utf8"),
  ...snapshot(join(h.home, ".local/share/mate")),
  ...snapshot(join(h.home, "mate")),
];

describe("mate node CLI (MODULE_TESTS 9)", () => {
  it("install puts the program, the mate command and the unit in place without starting anything, and start then enables and starts the service", () => {
    const h = host();
    const out = ok(h, "node", "install", writeBundle(h.inputs, { version: "1.0.0" }));
    expect(installedVersion(h)).toBe("1.0.0");
    expect(readlinkSync(command(h))).toBe(join(program(h), "bin/mate"));
    expect(readFileSync(unit(h), "utf8")).toContain(
      "ExecStart=%h/.local/lib/mate-node/node/bin/node %h/.local/lib/mate-node/lib/mate.mjs node run",
    );
    expect(serviceChanges(h), "install never starts or enables").toEqual([]);
    expect(out, "install tells the owner what is left to do").toContain("mate node configure");

    expect(refused(h, "node", "start"), "start needs a config").toContain("configure");
    expect(serviceChanges(h)).toEqual([]);
    ok(h, "node", "configure", "--control-plane", "http://127.0.0.1:8787", "--pairing-token", "t");
    ok(h, "node", "start");
    expect(h.systemd()).toMatchObject({ active: "active", enabled: "enabled" });
  });

  it("install again changes nothing and never starts, restarts or re-enables the service, whether it runs or the owner stopped it", () => {
    const h = runningNode();
    const bundle = join(h.inputs, "mate-node-1.0.0.tar.gz");
    const before = snapshot(h.home);
    h.setSystemd({ calls: [] });
    ok(h, "node", "install", bundle);
    expect(serviceChanges(h), "a running service is left running").toEqual([]);
    expect(snapshot(h.home)).toEqual(before);

    ok(h, "node", "stop");
    expect(h.systemd()).toMatchObject({ active: "inactive", enabled: "disabled" });
    h.setSystemd({ calls: [] });
    ok(h, "node", "install", bundle);
    ok(h, "node", "install", bundle);
    expect(serviceChanges(h), "a stopped service stays stopped").toEqual([]);
    expect(h.systemd()).toMatchObject({ active: "inactive", enabled: "disabled" });
  });

  it("install refuses a bundle of another version than the installed one and changes nothing", () => {
    const h = runningNode("1.0.0");
    const before = snapshot(h.home);
    expect(refused(h, "node", "install", writeBundle(h.inputs, { version: "2.0.0" }))).toContain(
      "mate node update",
    );
    expect(snapshot(h.home)).toEqual(before);
  });

  it.each(["active", "activating", "deactivating", "reloading"])(
    "update refuses while the service is %s and changes nothing",
    (active) => {
      const h = runningNode();
      h.setSystemd({ active, calls: [] });
      const before = snapshot(h.home);
      expect(refused(h, "node", "update", writeBundle(h.inputs, { version: "2.0.0" }))).toContain(
        "mate node stop",
      );
      expect(snapshot(h.home)).toEqual(before);
      expect(serviceChanges(h)).toEqual([]);
    },
  );

  it("update replaces the program while the service is stopped, keeps it stopped, and leaves config, identity and workspaces untouched", () => {
    const h = runningNode("1.0.0");
    ok(h, "node", "stop");
    const data = agentData(h);
    h.setSystemd({ calls: [] });
    ok(h, "node", "update", writeBundle(h.inputs, { version: "2.0.0" }));
    expect(installedVersion(h)).toBe("2.0.0");
    expect(readFileSync(join(program(h), "lib/mate.mjs"), "utf8")).toBe("// mate 2.0.0\n");
    expect(readlinkSync(command(h))).toBe(join(program(h), "bin/mate"));
    expect(serviceChanges(h), "update never starts the service").toEqual([]);
    expect(h.systemd().active).toBe("inactive");
    expect(agentData(h)).toEqual(data);
    expect(scratch(h)).toEqual([]);
  });

  it("an update that died between moving the old program aside and placing the new one completes when run again", () => {
    const h = runningNode("1.0.0");
    ok(h, "node", "stop");
    const data = agentData(h);
    const lib = join(h.home, ".local/lib");
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
    const child = h.spawnMate("node", "update", bundle);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    await eventually(() => scratch(h).length > 0, "update starts unpacking", 10_000);
    child.kill("SIGKILL");
    await exited;
    expect(snapshot(program(h)), "the killed run left the old program whole").toEqual(installed);

    ok(h, "node", "update", bundle);
    expect(installedVersion(h)).toBe("2.0.0");
    expect(scratch(h)).toEqual([]);
  });

  it("uninstall stops the service and removes the program, the command and the unit, keeps config, identity and workspaces, and finds nothing to do when run again", () => {
    const h = runningNode();
    const data = agentData(h);
    ok(h, "node", "uninstall");
    expect(h.systemd()).toMatchObject({ active: "inactive", enabled: "disabled" });
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
        const old = join(h.home, ".local/lib/.mate-node-old-abc123");
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
    mkdirSync(join(h.home, ".config/systemd/user"), { recursive: true });
    writeFileSync(unit(h), "[Service]\nExecStart=/opt/my-own-node\n");
    mkdirSync(join(h.home, ".local/bin"), { recursive: true });
    writeFileSync(command(h), "#!/bin/sh\necho my own mate\n");
    const theirs = () => [readFileSync(unit(h), "utf8"), readFileSync(command(h), "utf8")];
    const before = theirs();

    const installed = ok(h, "node", "install", writeBundle(h.inputs, { version: "1.0.0" }));
    expect(installed).toContain(unit(h));
    expect(installed).toContain(command(h));
    expect(theirs()).toEqual(before);
    const callsBefore = h.systemd().calls.length;
    const removed = ok(h, "node", "uninstall");
    expect(removed).toContain(unit(h));
    expect(removed).toContain(command(h));
    expect(theirs()).toEqual(before);
    expect(
      h
        .systemd()
        .calls.slice(callsBefore)
        .map(([, verb]) => verb),
      "uninstall only reads the state of a service Mate did not define",
    ).toEqual(["show"]);
    expect(existsSync(program(h))).toBe(false);
  });

  it("install, update and uninstall refuse without a user manager and change nothing", () => {
    const h = runningNode();
    ok(h, "node", "stop");
    h.setSystemd({ available: false });
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
      expect(h.systemd().calls).toEqual([]);
    },
  );

  it("configure writes a private config, and writing it again without a pairing token drops the token", () => {
    const h = host();
    ok(h, "node", "configure", "--control-plane", "https://mate.example", "--pairing-token", "t1");
    expect(statSync(config(h)).mode & 0o777).toBe(0o600);
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
    expect(out).toContain("active");
    expect(out).toContain("http://127.0.0.1:8787");
    expect(out).not.toContain("secret-pairing-token");
  });

  it("logs reads the service's journal, and follows it when asked", () => {
    const h = runningNode();
    expect(ok(h, "node", "logs")).toContain("a journal line");
    ok(h, "node", "logs", "--follow", "--lines", "20");
    const [plain, following] = h.systemd().journal;
    expect(plain).toEqual(expect.arrayContaining(["--user", "--unit", "mate-node.service"]));
    expect(following).toEqual(expect.arrayContaining(["--follow", "--lines", "20"]));
    expect(plain).not.toContain("--follow");
  });

  it("node run without a config exits with a status the service unit does not restart", () => {
    const h = host();
    ok(h, "node", "install", writeBundle(h.inputs, { version: "1.0.0" }));
    const noRestart = /^RestartPreventExitStatus=(.+)$/m.exec(readFileSync(unit(h), "utf8"))?.[1];
    const result = h.mate("node", "run");
    expect(result.stderr).toContain("configure");
    expect(noRestart?.split(" ")).toContain(String(result.status));
  });
});
