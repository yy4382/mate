import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { FakeGateway } from "@mate/testkit";
import { expect, it, onTestFinished } from "vitest";
import { hostPaths } from "./cli-support.ts";
import {
  eventually,
  longCommand,
  pidsOf,
  running,
  temporaryDirectory,
  windows,
} from "./support.ts";

const nativeService = process.env["MATE_TEST_NATIVE_SERVICE"] === "1";

it.runIf(nativeService)(
  "the published bundle installs a native service, reports its real link, manually restarts a crashed Windows node, stops its process tree and does not retry identity refusal (dedicated CI account only)",
  async () => {
    expect(process.env["CI"], "native service smoke must use a disposable CI account").toBe("true");
    expect(["darwin", "win32"]).toContain(process.platform);
    const paths = hostPaths(homedir(), process.env["LOCALAPPDATA"]);
    for (const path of [paths.program, paths.command, paths.unit, paths.config, paths.data]) {
      expect(existsSync(path), `native smoke requires an account without ${path}`).toBe(false);
    }

    const directory = resolve(process.env["MATE_TEST_BUNDLE_DIRECTORY"]!);
    const target = `${windows ? "win" : "darwin"}-${process.arch}`;
    const bundles = readdirSync(directory).filter((file) => file.endsWith(`-${target}.tar.gz`));
    expect(bundles, "one real release bundle for this host").toHaveLength(1);
    const bundle = join(directory, bundles[0]!);
    const extraction = temporaryDirectory();
    const unpacked = spawnSync("tar", ["-xzf", bundle, "-C", extraction], { encoding: "utf8" });
    expect(unpacked.status, unpacked.stderr).toBe(0);
    const program = join(extraction, "mate-node");
    const runtime = join(program, windows ? "node/node.exe" : "node/bin/node");
    const script = join(program, "lib/mate.mjs");
    let installed = false;
    const fromBundle = (...args: string[]) =>
      spawnSync(runtime, [script, "node", ...args], { encoding: "utf8" });
    const mate = (...args: string[]) => {
      if (!installed) return fromBundle(...args);
      if (!windows) return spawnSync(paths.command, ["node", ...args], { encoding: "utf8" });
      const command = [paths.command, "node", ...args].map((argument) => `"${argument}"`).join(" ");
      return spawnSync("cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
        encoding: "utf8",
        windowsVerbatimArguments: true,
      });
    };
    const ok = (...args: string[]): string => {
      const result = mate(...args);
      expect(
        result.status,
        `mate node ${args.join(" ")}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      ).toBe(0);
      return result.stdout;
    };

    const initial = ok("status");
    expect(initial).toContain("Unit: missing");
    expect(initial).not.toContain("not Mate's");
    expect(initial).not.toContain("Service: unknown");
    expect(initial).toContain("Link: none");

    onTestFinished(() => {
      if (installed) {
        const removed = fromBundle("uninstall");
        expect(removed.status, removed.stderr).toBe(0);
      }
      rmSync(paths.config, { force: true });
      rmSync(paths.data, { recursive: true, force: true });
    });
    ok("install", bundle);
    installed = true;
    expect(ok("status")).toContain("disabled");
    expect(mate("start").status).toBe(1);

    let accepting = true;
    let attempts = 0;
    const gateway = new FakeGateway({
      onConnect: () => {
        attempts += 1;
        return accepting;
      },
    });
    await gateway.start();
    onTestFinished(() => gateway.close());
    const workspaces = temporaryDirectory();
    ok(
      "configure",
      "--control-plane",
      gateway.url,
      "--pairing-token",
      "native-smoke-token",
      "--workspaces",
      workspaces,
    );
    ok("start");
    await gateway.waitForNode(30_000);
    await eventually(
      () => ok("status").includes("Link: connected since"),
      "the native manager verifies the node process that wrote link.json",
      30_000,
    );
    const linkFile = join(paths.data, "link.json");
    let nodePid = JSON.parse(readFileSync(linkFile, "utf8")).pid as number;
    expect(running(nodePid)).toBe(true);
    const powershell = (script: string): string => {
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    const task = `
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$name = 'Mate node ' + $sid
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
$task = $folder.GetTask($name)
`;
    if (windows) {
      const authentications = gateway.authentications;
      powershell(`
$ErrorActionPreference = 'Stop'
Add-Type -Name NativeProcess -Namespace MateTest -MemberDefinition '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr handle, uint exitCode);'
$node = Get-Process -Id ${nodePid}
if (-not [MateTest.NativeProcess]::TerminateProcess($node.Handle, 1)) { throw 'Could not terminate node' }
$node.WaitForExit()
if ($node.ExitCode -ne 1) { throw "Expected node exit 1, got $($node.ExitCode)" }
`);
      await eventually(
        () => {
          const status = ok("status");
          return status.includes("Service: ready, enabled") && status.includes("Link: none");
        },
        "the task manager has observed the crashed node exit",
        30_000,
      );
      ok("start");
      await eventually(
        () => gateway.authentications > authentications,
        "mate node start reconnects after the crashed Windows task",
        30_000,
      );
      await eventually(
        () => {
          const link = JSON.parse(readFileSync(linkFile, "utf8"));
          return link.pid !== nodePid && link.connected;
        },
        "the restarted node publishes its new connection",
        30_000,
      );
      const restartedPid = JSON.parse(readFileSync(linkFile, "utf8")).pid as number;
      expect(running(nodePid)).toBe(false);
      nodePid = restartedPid;
      expect(ok("status")).toContain("Link: connected since");
    }

    const agentId = randomUUID();
    expect((await gateway.prepareWorkspace(randomUUID(), agentId)).isError).toBe(false);
    const command = gateway
      .runTool(randomUUID(), agentId, "bash", { command: longCommand("native-service") })
      .catch(() => undefined);
    const descendants = await pidsOf(join(workspaces, agentId), "native-service");
    expect(descendants).toHaveLength(3);
    expect(descendants.every(running)).toBe(true);
    ok("stop");
    await command;
    await eventually(
      () => !running(nodePid) && descendants.every((pid) => !running(pid)),
      "native stop kills the node and its live command tree",
      30_000,
    );
    expect(ok("status")).toContain("Link: none");

    const updateDirectory = resolve(process.env["MATE_TEST_UPDATE_BUNDLE_DIRECTORY"]!);
    const updates = readdirSync(updateDirectory).filter((file) =>
      file.endsWith(`-${target}.tar.gz`),
    );
    expect(updates, "one different release bundle for the update").toHaveLength(1);
    const update = join(updateDirectory, updates[0]!);
    const identityFile = join(paths.data, "node-identity.json");
    const identity = readFileSync(identityFile);
    const config = readFileSync(paths.config);
    const beforeVersion = JSON.parse(
      readFileSync(join(paths.program, "manifest.json"), "utf8"),
    ).version;
    if (windows) {
      powershell(`${task}
$definition = $task.Definition
$definition.Actions.Item(1).Arguments += ' --obsolete-argument'
$folder.RegisterTaskDefinition($name, $definition, 6, $sid, $null, 3, $null) | Out-Null
`);
    }
    ok("update", update);
    if (windows) {
      const argumentsText = powershell(`${task}
$task.Definition.Actions.Item(1).Arguments`);
      expect(argumentsText).not.toContain("--obsolete-argument");
      expect(argumentsText.trim()).toMatch(/ node run --service$/);
    }
    const updatedVersion = JSON.parse(
      readFileSync(join(paths.program, "manifest.json"), "utf8"),
    ).version;
    expect(updatedVersion).toBe("0.0.0-ci-update");
    expect(updatedVersion).not.toBe(beforeVersion);
    expect(readFileSync(identityFile)).toEqual(identity);
    expect(readFileSync(paths.config)).toEqual(config);
    const stopped = ok("status");
    expect(stopped).toContain("disabled");
    expect(stopped).toContain("Link: none");

    accepting = false;
    const beforeRefusal = attempts;
    ok("start");
    const log = join(paths.data, "node.log");
    await eventually(
      () => existsSync(log) && readFileSync(log, "utf8").includes("Node exiting:"),
      "the service logs its permanent identity refusal",
      30_000,
    );
    await eventually(
      () => {
        const status = ok("status");
        return (
          status.includes("Link: none") && (!windows || status.includes("Service: ready, enabled"))
        );
      },
      "the task manager has observed the refused node exit",
      30_000,
    );
    expect(attempts).toBeGreaterThan(beforeRefusal);
    if (!windows) {
      const afterRefusal = attempts;
      await wait(6_500);
      expect(attempts, "a permanent refusal is not retried after the native restart interval").toBe(
        afterRefusal,
      );
    }
    expect(ok("logs")).toContain("Node exiting:");
    ok("stop");
    ok("uninstall");
    installed = false;
    for (const path of [paths.program, paths.command, paths.unit])
      expect(existsSync(path)).toBe(false);
    expect(existsSync(paths.config)).toBe(true);
    expect(existsSync(paths.data)).toBe(true);
  },
  300_000,
);
