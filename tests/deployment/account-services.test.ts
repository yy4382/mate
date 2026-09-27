import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  accountServiceReports,
  readServiceLog,
  readServiceState,
  restartAccountServices,
  startAccountServices,
  stopAccountServices,
} from "../../src/deployment/account-services.js";
import { nodeCommandStopReport, nodeCommandStopReportUnavailable } from "../../src/nodes/client.js";

/**
 * One small real child process stands in for a Mate service here: it prints the readiness line the
 * supervisor waits for, and exits when it is asked to. Nothing about the checked behaviour is
 * mocked — the supervisor really spawns it, really records its process incarnation, and really
 * signals it.
 */
const entry = `
  import { createServer } from "node:net";
  process.on("SIGTERM", () => process.exit(0));
  // The port is announced only after the socket accepts connections, which is the same promise the
  // real control plane makes when it prints its own readiness line.
  createServer(() => {}).listen(Number(process.env.MATE_CONTROL_PLANE_PORT ?? 0), "127.0.0.1", () => {
    process.stdout.write("MATE_CONTROL_PLANE_LISTENING " + process.env.MATE_CONTROL_PLANE_PORT + "\\n");
  });
`;

const processes: ChildProcess[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const child of processes.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

function startedReport(
  result: Awaited<ReturnType<typeof startAccountServices>>,
  name: "control-plane" | "node",
): { pid: number } {
  const report = result.reports[name];
  if (!report || report.state !== "running") throw new Error(`${name} did not start`);
  return report;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mate-account-services-")),
    entryFile = join(root, "fake-service.mjs"),
    stateDir = join(root, "state");
  roots.push(root);
  writeFileSync(entryFile, entry, "utf8");
  return {
    root,
    stateDir,
    logPath: join(stateDir, "control-plane.log"),
    recordPath: join(stateDir, "control-plane.json"),
    config: {
      stateDir,
      // The node entry is present so the shape matches a real deployment; these tests only drive
      // the control-plane service, which is the entry whose readiness line they can control.
      entries: { "control-plane": entryFile, node: entryFile },
      environment: {
        "control-plane": { MATE_CONTROL_PLANE_PORT: String(await freePort()) },
      },
      probeUrls: {},
    },
  };
}

it("starts, reports, restarts and stops an ordinary account service it really spawned", async () => {
  const f = await fixture();
  expect(readServiceState("control-plane", f.config)).toEqual({ state: "not_running" });

  const started = await startAccountServices(f.config, ["control-plane"]),
    pid = startedReport(started, "control-plane").pid;
  expect(pid).toBeGreaterThan(0);
  expect(existsSync(f.recordPath)).toBe(true);
  expect(JSON.parse(readFileSync(f.recordPath, "utf8"))).toMatchObject({ pid });

  // A second start of a running service refuses instead of silently starting a duplicate.
  await expect(startAccountServices(f.config, ["control-plane"])).rejects.toThrow(
    /already running/,
  );

  const restarted = await restartAccountServices(f.config, ["control-plane"]),
    restartedPid = startedReport(restarted, "control-plane").pid;
  expect(restartedPid).not.toBe(pid);

  const stopped = await stopAccountServices(f.config, ["control-plane"]);
  expect(stopped.reports["control-plane"]).toMatchObject({ state: "stopped", pid: restartedPid });
  expect(readServiceState("control-plane", f.config)).toEqual({ state: "not_running" });
  // The pid really is gone, so "stopped" is an observation rather than a claim.
  expect(() => process.kill(restartedPid, 0)).toThrow();
  // The log keeps what the service printed, which is what an owner reads when diagnosing.
  expect(readFileSync(f.logPath, "utf8")).toMatch(/^MATE_CONTROL_PLANE_LISTENING \d+$/m);
});

it("reports a service whose readiness line never appears as exited, not running", async () => {
  const f = await fixture();
  writeFileSync(f.config.entries["control-plane"], "setInterval(() => {}, 1000);\n", "utf8");
  await expect(
    startAccountServices(f.config, ["control-plane"], { readinessTimeoutMs: 150 }),
  ).rejects.toThrow(/did not become ready/);
  const state = readServiceState("control-plane", f.config);
  expect(state).toMatchObject({ state: "exited" });
  expect((state as { reason: string }).reason).toContain("did not become ready");
  await stopAccountServices(f.config, ["control-plane"]);
});

it("reports a service that exited on its own as exited, with its exit status", async () => {
  const f = await fixture();
  writeFileSync(
    f.config.entries["control-plane"],
    'process.stderr.write("boom\\n"); process.exit(3);\n',
    "utf8",
  );
  await expect(
    startAccountServices(f.config, ["control-plane"], { readinessTimeoutMs: 2000 }),
  ).rejects.toThrow(/exited/);
  const state = readServiceState("control-plane", f.config);
  if (state.state !== "exited")
    throw new Error(`expected an exited service, got ${JSON.stringify(state)}`);
  expect(state.code).toBe(3);
  expect(accountServiceReports(f.config, ["control-plane"])).toMatchObject({
    "control-plane": {
      state: "exited",
      pid: state.pid,
      // A service that exited on its own during startup is reported as a failed start, with the
      // exit status and its own output, which is what the owner needs to diagnose it.
      summary: expect.stringContaining("code 3"),
    },
  });
  expect(readServiceLog("control-plane", f.config)).toContain("boom");
});

it("kills a service that printed its readiness line but never answers its probe", async () => {
  const f = await fixture();
  // The child announces itself and then holds a port nothing answers on, which is the shape of a
  // control plane that is up enough to print and not up enough to serve.
  const pidFile = join(f.root, "child.pid");
  writeFileSync(
    f.config.entries["control-plane"],
    `import { writeFileSync } from "node:fs";
     writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
     process.stdout.write("MATE_CONTROL_PLANE_LISTENING 1\\n");
     setInterval(() => {}, 1000);
    `,
    "utf8",
  );
  const probing = {
    ...f.config,
    probeUrls: { "control-plane": "http://127.0.0.1:1/api/status" },
  };
  // A start whose probe never answers must end in the same bounded time as any other failed start:
  // the probe budget plus the stop budget, not an open-ended wait.
  const started = Date.now();
  await expect(
    startAccountServices(probing, ["control-plane"], { readinessTimeoutMs: 2000 }),
  ).rejects.toThrow(/did not answer/);
  expect(Date.now() - started).toBeLessThan(9000);
  const childPid = Number(readFileSync(pidFile, "utf8"));
  expect(childPid).toBeGreaterThan(0);
  // The failed start really did end the process it started, and says so with the reason it had.
  expect(() => process.kill(childPid, 0)).toThrow();
  expect(readServiceState("control-plane", probing)).toMatchObject({ state: "exited" });
});

it("does not leave a service running when its start failed", async () => {
  const f = await fixture();
  // This child prints nothing and holds its PID in a file, so the test can check the real process
  // rather than Mate's own record of it.
  const pidFile = join(f.root, "child.pid");
  writeFileSync(
    f.config.entries["control-plane"],
    `import { writeFileSync } from "node:fs";
     writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
     setInterval(() => {}, 1000);
    `,
    "utf8",
  );
  await expect(
    startAccountServices(f.config, ["control-plane"], { readinessTimeoutMs: 150 }),
  ).rejects.toThrow(/did not become ready/);
  const childPid = Number(readFileSync(pidFile, "utf8"));
  expect(childPid).toBeGreaterThan(0);
  expect(() => process.kill(childPid, 0)).toThrow();
  expect(readServiceState("control-plane", f.config)).toMatchObject({ state: "exited" });
});

/**
 * A node stands in for the real one here: it announces a paired session, and on the way out it
 * writes the same shutdown line `client.ts` writes. What the stop then reports is what the owner
 * gets to act on, so it has to be the service's own account of its commands and nothing else.
 */
async function nodeWithShutdownReportConfig(
  f: Awaited<ReturnType<typeof fixture>>,
  shutdown: string,
) {
  const entryFile = join(f.root, "fake-node.mjs");
  writeFileSync(
    entryFile,
    `process.on("SIGTERM", () => {
       process.stderr.write(${JSON.stringify(shutdown)});
       process.exit(0);
     });
     process.stdout.write("MATE_NODE_CONNECTED 11111111-1111-4111-8111-111111111111\\n");
     setInterval(() => {}, 1000);
    `,
    "utf8",
  );
  return { ...f.config, entries: { ...f.config.entries, node: entryFile } };
}

async function nodeWithShutdownReport(f: Awaited<ReturnType<typeof fixture>>, shutdown: string) {
  const config = await nodeWithShutdownReportConfig(f, shutdown);
  await startAccountServices(config, ["node"]);
  return stopAccountServices(config, ["node"]);
}

it("reports the commands a stopped node said it could not confirm ended", async () => {
  const f = await fixture();
  const stopped = await nodeWithShutdownReport(f, nodeCommandStopReport(1, 2));
  expect(stopped.reports.node).toMatchObject({ state: "stopped", unconfirmedCommands: 2 });
});

it("reports an unknown command count when the stopping node could not stop its commands", async () => {
  const f = await fixture();
  const stopped = await nodeWithShutdownReport(f, nodeCommandStopReportUnavailable);
  expect(stopped.reports.node).toMatchObject({ state: "stopped", unconfirmedCommands: "unknown" });
});

it("carries the warning through a restart instead of reporting a clean start", async () => {
  const f = await fixture();
  // A restart is the repair action for a node that could not confirm ending a command — its receipts
  // get reconciled on the way back up — but its report must still say the stop was not clean.
  const config = await nodeWithShutdownReportConfig(f, nodeCommandStopReport(1, 2));
  await startAccountServices(config, ["node"]);
  const restarted = await restartAccountServices(config, ["node"]);
  expect(restarted.reports.node).toMatchObject({
    state: "running",
    unconfirmedCommands: 2,
  });
});

it("claims nothing about commands when the stopped node reported none", async () => {
  const f = await fixture();
  // The node ended what it was running and said so: the stop is a clean quiesce, and the report
  // must not carry a command warning that no evidence supports.
  const stopped = await nodeWithShutdownReport(f, nodeCommandStopReport(1, 0));
  expect(stopped.reports.node).toMatchObject({ state: "stopped" });
  expect(stopped.reports.node).not.toHaveProperty("unconfirmedCommands");
});

it("never claims a killed node ended the commands it had no chance to report on", async () => {
  const f = await fixture();
  // A node that ignores SIGTERM is killed, so the shutdown that would have reported on its
  // commands never runs. Silence there is not a report that they ended.
  const entryFile = join(f.root, "stubborn-node.mjs");
  writeFileSync(
    entryFile,
    `process.on("SIGTERM", () => {});
     process.stdout.write("MATE_NODE_CONNECTED 11111111-1111-4111-8111-111111111111\\n");
     setInterval(() => {}, 1000);
    `,
    "utf8",
  );
  const config = { ...f.config, entries: { ...f.config.entries, node: entryFile } };
  await startAccountServices(config, ["node"]);
  const stopped = await stopAccountServices(config, ["node"], { stopTimeoutMs: 200 });
  expect(stopped.reports.node).toMatchObject({ state: "stopped", unconfirmedCommands: "unknown" });
});
