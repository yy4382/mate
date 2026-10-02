import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { runScenario, ScenarioFailure } from "../helpers/scenario-evidence.js";
import { createScriptedProvider, type ScriptedRequest } from "../helpers/scripted-provider.js";
import { waitForScenario } from "../helpers/scenario-driver.js";
import { ProcessOutput, ownerPassword, stopProcess } from "../helpers/run-services.js";
import { scriptedToolResultSchemas } from "../helpers/scripted-tool-results.js";

it("retains original assertion and real request/result/file evidence before cleanup, then reruns successfully", async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), "mate-evidence-test-"));
  const original = new Error("expected synthetic report total 99");
  let runtimeDirectory = "";
  async function scenario(fail: boolean) {
    const provider = createScriptedProvider();
    return runScenario({
      name: "short-real-report",
      evidenceRoot,
      provider,
      environment: { agents: [{ name: "证据同事" }] },
      async run({ environment, driver, step, effectFile }) {
        runtimeDirectory = environment.directory;
        const agent = environment.agents[0];
        if (!agent) throw new Error("Expected prepared Agent");
        provider.forAgent(agent, [
          function writeReport(request: ScriptedRequest) {
            request.call("process.exec", {
              command: "printf 'total=12\\n' > report.txt; cat report.txt",
            });
          },
          function readReport(request: ScriptedRequest) {
            expect(
              request.result("process.exec", scriptedToolResultSchemas["process.exec"]).receipt
                ?.stdout,
            ).toBe("total=12\n");
            request.text("报告已写入。");
          },
        ]);
        effectFile("report.txt", join(agent.workspace, "report.txt"));
        await step("deliver report", async () => {
          const target = await driver.sendOwnerMessage(agent, "写合成报告。");
          return driver.waitForRun(target, "completed");
        });
        await step("assert report total", () => {
          if (fail) throw original;
          expect(readFileSync(join(agent.workspace, "report.txt"), "utf8")).toBe("total=12\n");
        });
        await provider.assertComplete();
      },
    });
  }
  try {
    const failure = await scenario(true).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScenarioFailure);
    if (!(failure instanceof ScenarioFailure)) throw new Error("Expected evidence failure");
    expect(failure.cause).toBe(original);
    expect(failure.cleanup.flatMap((report) => report.failures)).toEqual([]);
    expect(existsSync(runtimeDirectory)).toBe(false);
    const summary = JSON.parse(
      readFileSync(join(failure.evidenceDirectory, "summary.json"), "utf8"),
    );
    expect(summary).toMatchObject({
      name: "short-real-report",
      checkout: {
        sha: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
        platform: process.platform,
      },
      assertions: [
        { name: "deliver report", status: "passed" },
        { name: "assert report total", status: "failed" },
      ],
      lastEvent: { name: "deliver report" },
    });
    expect(summary.processes).toHaveLength(2);
    expect(readFileSync(join(failure.evidenceDirectory, "effects", "report.txt"), "utf8")).toBe(
      "total=12\n",
    );
    const requests = JSON.parse(
      readFileSync(join(failure.evidenceDirectory, "model-requests.json"), "utf8"),
    );
    expect(requests.map((request: { step: string }) => request.step)).toEqual([
      "writeReport",
      "readReport",
    ]);
    expect(JSON.stringify(requests)).toContain("total=12");
    const facts = JSON.parse(
      readFileSync(join(failure.evidenceDirectory, "persistent-facts.json"), "utf8"),
    );
    expect(facts.runs[0]).toMatchObject({ state: "completed" });
    expect(facts.operations[0]).toMatchObject({ state: "succeeded" });
    await scenario(false);
    expect(existsSync(runtimeDirectory)).toBe(false);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
}, 30_000);

it("keeps the scenario cause when effect collection and one release fail, and retries the existing close", async () => {
  const root = mkdtempSync(join(tmpdir(), "mate-evidence-errors-"));
  const original = new Error("original synthetic assertion");
  const releaseError = new Error("one synthetic release failed");
  let otherReleased = false;
  let attempts = 0;
  try {
    const failure = await runScenario({
      name: "broken-evidence-and-release",
      evidenceRoot: root,
      provider: createScriptedProvider(),
      environment: { agents: [{ name: "保存失败同事" }] },
      async run({ environment, step, effectFile }) {
        environment.registerCleanup("other synthetic release", () => {
          otherReleased = true;
        });
        environment.registerCleanup("retry synthetic release", () => {
          if (++attempts === 1) throw releaseError;
        });
        const agent = environment.agents[0];
        if (!agent) throw new Error("Expected prepared Agent");
        effectFile("missing.txt", join(agent.workspace, "missing.txt"));
        await step("original assertion", () => {
          throw original;
        });
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ScenarioFailure);
    if (!(failure instanceof ScenarioFailure)) throw new Error("Expected preserved failure");
    expect(failure.cause).toBe(original);
    expect(failure.evidenceErrors).toHaveLength(1);
    expect(failure.cleanup.flatMap((report) => report.failures)).toEqual([
      { resource: "retry synthetic release", error: releaseError },
    ]);
    expect(otherReleased).toBe(true);
    expect(await failure.close()).toEqual({ released: ["retry synthetic release"], failures: [] });
    const summary = JSON.parse(
      readFileSync(join(failure.evidenceDirectory, "summary.json"), "utf8"),
    );
    expect(summary.error.message).toBe(original.message);
    expect(summary.evidenceErrors).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(!process.env.MATE_EVIDENCE_PROBE_MODE)(
  "standalone evidence probe",
  async () => {
    const mode = process.env.MATE_EVIDENCE_PROBE_MODE;
    const evidenceRoot = process.env.MATE_EVIDENCE_PROBE_ROOT;
    if (!mode || !evidenceRoot) throw new Error("Expected explicit synthetic probe configuration");
    const provider = createScriptedProvider({ timeoutMs: 15_000 });
    await runScenario({
      name: `real-${mode}`,
      evidenceRoot,
      provider,
      environment: {
        agents: [{ name: "信号证据同事" }],
        ...(process.env.MATE_EVIDENCE_PROBE_IMAGE
          ? { container: { image: process.env.MATE_EVIDENCE_PROBE_IMAGE } }
          : {}),
      },
      async run({ environment, driver, step, effectFile, signal }) {
        const agent = environment.agents[0];
        if (!agent) throw new Error("Expected prepared Agent");
        provider.forAgent(agent, [
          function writeReport(request: ScriptedRequest) {
            request.call("process.exec", {
              command: "printf 'total=12\\n' > report.txt; cat report.txt",
            });
          },
          function holdRealRequest(request: ScriptedRequest) {
            request.expectCancellation("scenario probe stopped");
          },
        ]);
        effectFile("report.txt", join(agent.workspace, "report.txt"));
        const target = await driver.sendOwnerMessage(agent, "准备可诊断的真实报告。");
        const pending = await provider.waitFor(agent.summary.id, "holdRealRequest");
        await step("report written", () =>
          pending.result("process.exec", scriptedToolResultSchemas["process.exec"]),
        );
        const run = await driver.waitForRun(target, "running");
        process.stdout.write(
          `MATE_EVIDENCE_READY ${JSON.stringify({ driverPid: process.pid, directory: environment.directory, origin: environment.origin, runId: run.id })}\n`,
        );
        await step("unreachable completion", () =>
          waitForScenario(
            "unreachable named event",
            async () => ({ runId: run.id, observed: "report written" }),
            () => false,
            { timeoutMs: mode === "timeout" ? 75 : 15_000, signal },
          ),
        );
      },
    });
  },
  30_000,
);

for (const mode of ["timeout", "SIGINT", "SIGTERM", "SIGKILL", "SIGKILL-no-directory"]) {
  it(`captures a real ${mode} failure and reruns without its services or ports`, async () => {
    const root = mkdtempSync(join(tmpdir(), "mate-evidence-signal-"));
    const probe = new ProcessOutput(
      spawn(
        process.execPath,
        [
          resolve("node_modules/vitest/vitest.mjs"),
          "run",
          "tests/control-plane/scenario-evidence.test.ts",
          "-t",
          "^standalone evidence probe$",
        ],
        {
          env: { ...process.env, MATE_EVIDENCE_PROBE_MODE: mode, MATE_EVIDENCE_PROBE_ROOT: root },
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
    let passed = false;
    let failed = false;
    try {
      const ready = JSON.parse(
        (await probe.waitFor(/MATE_EVIDENCE_READY (\{[^\n]+\})/))[1] ?? "null",
      );
      if (mode !== "timeout")
        process.kill(
          ready.driverPid,
          mode === "SIGINT" ? "SIGINT" : mode === "SIGTERM" ? "SIGTERM" : "SIGKILL",
        );
      await waitForScenario(
        "probe driver exit",
        () => probe.exitStatus,
        (status) => status !== undefined,
      );
      expect(probe.exitStatus?.code).toBe(1);
      const name = readdirSync(root)[0];
      if (!name) throw new Error("Expected created evidence directory");
      const directory = join(root, name);
      if (mode.startsWith("SIGKILL")) {
        expect(existsSync(join(directory, "summary.json"))).toBe(false);
        expect((await fetch(ready.origin)).ok).toBe(true);
        if (mode === "SIGKILL-no-directory")
          rmSync(ready.directory, { recursive: true, force: true });
        const initial = spawnSync(
          process.execPath,
          ["tests/helpers/scenario-cleanup.mjs", join(directory, "resources.json")],
          { encoding: "utf8", timeout: 15_000 },
        );
        writeFileSync(join(directory, "independent-cleanup-initial.json"), initial.stdout);
        expect(initial.status, initial.stdout || String(initial.error)).toBe(0);
        const result = JSON.parse(initial.stdout);
        expect(result.guarantee).toContain("SIGKILL does not execute finally");
        expect(result.reports[0]).toMatchObject({ residual: [], errors: [] });
      } else {
        const summary = JSON.parse(readFileSync(join(directory, "summary.json"), "utf8"));
        expect(summary.lastEvent.name).toBe("report written");
        expect(summary.assertions).toContainEqual({
          name: "unreachable completion",
          status: "failed",
        });
        expect(JSON.stringify(summary.error)).toContain(
          mode === "timeout" ? "unreachable named event" : `Scenario cancelled by ${mode}`,
        );
        expect(summary.processes).toHaveLength(2);
        expect(readFileSync(join(directory, "effects", "report.txt"), "utf8")).toBe("total=12\n");
      }
      expect(existsSync(ready.directory)).toBe(false);
      await expect(fetch(ready.origin)).rejects.toThrow();
      // The identical entry point starts real services again; the previous controlled failure stays visible.
      await runScenario({
        name: "rerun",
        evidenceRoot: root,
        provider: createScriptedProvider(),
        environment: { agents: [{ name: "再次运行同事" }] },
        async run({ environment, step }) {
          await step("ready again", () => {
            expect(environment.agents).toHaveLength(1);
            return { agentId: environment.agents[0]?.summary.id };
          });
        },
      });
      passed = true;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (!passed) console.error(probe.text);
      try {
        await stopProcess(probe);
        // Only this test's manifests, never a global scan/prune.
        execFileSync(process.execPath, ["tests/helpers/scenario-cleanup.mjs", "--root", root], {
          encoding: "utf8",
          timeout: 15_000,
        });
        if (passed) rmSync(root, { recursive: true, force: true });
      } catch (error) {
        console.error(`MATE_SCENARIO_PROBE_CLEANUP_FAILED ${root}`, error);
        if (!failed) throw error;
      }
      if (!passed) console.error(`MATE_SCENARIO_PROBE_RETAINED ${root}`);
    }
  }, 45_000);
}

it("redacts credentials in synthetic effects and projections and refuses files outside its own workspaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "mate-evidence-private-"));
  const original = new Error("synthetic privacy assertion");
  try {
    const provider = createScriptedProvider();
    const failure = await runScenario({
      name: "synthetic privacy",
      evidenceRoot: root,
      provider,
      environment: { agents: [{ name: "隐私证据同事" }] },
      async run({ environment, driver, effectFile }) {
        const agent = environment.agents[0];
        if (!agent) throw new Error("Expected prepared Agent");
        const synthetic = JSON.stringify({
          report: "total=12",
          password: ownerPassword,
          apiKey: "synthetic-control-only-key",
          downloadToken: "synthetic-download-secret",
          download_token: "synthetic-snake-download-secret",
          access_token: "synthetic-snake-access-secret",
          refresh_token: "synthetic-snake-refresh-secret",
          private_key: "synthetic-snake-private-secret",
          token: "synthetic-generic-token-secret",
          cookie: "synthetic-cookie-secret",
          privateKey:
            "-----BEGIN PRIVATE KEY-----\nsynthetic-private-secret\n-----END PRIVATE KEY-----",
        });
        provider.forAgent(agent, [
          function writeSyntheticFixture(request: ScriptedRequest) {
            request.call("process.exec", { command: `printf '%s' '${synthetic}' > effect.json` });
          },
          function finishFixture(request: ScriptedRequest) {
            request.text("合成数据已写入。");
          },
        ]);
        effectFile("effect.json", join(agent.workspace, "effect.json"));
        effectFile("forbidden-password", join(environment.directory, "owner-password"));
        const target = await driver.sendOwnerMessage(agent, "保存合成结果。");
        await driver.waitForRun(target, "completed");
        throw original;
      },
    }).catch((error: unknown) => error);
    if (!(failure instanceof ScenarioFailure)) throw new Error("Expected privacy evidence failure");
    expect(failure.cause).toBe(original);
    expect(failure.evidenceErrors).toHaveLength(1);
    expect(existsSync(join(failure.evidenceDirectory, "effects", "forbidden-password"))).toBe(
      false,
    );
    const files = readdirSync(failure.evidenceDirectory, { recursive: true }).filter(
      (name) => typeof name === "string" && (name.endsWith(".json") || name.endsWith(".txt")),
    );
    const evidence = files
      .map((name) => readFileSync(join(failure.evidenceDirectory, String(name)), "utf8"))
      .join("\n");
    for (const secret of [
      ownerPassword,
      "synthetic-control-only-key",
      "synthetic-download-secret",
      "synthetic-snake-download-secret",
      "synthetic-snake-access-secret",
      "synthetic-snake-refresh-secret",
      "synthetic-snake-private-secret",
      "synthetic-generic-token-secret",
      "synthetic-cookie-secret",
      "synthetic-private-secret",
    ])
      expect(evidence).not.toContain(secret);
    expect(evidence).toContain("total=12");
    expect(
      JSON.parse(readFileSync(join(failure.evidenceDirectory, "effects", "effect.json"), "utf8"))
        .downloadToken,
    ).toBe("[REDACTED]");
    expect(files.some((name) => String(name).includes("sqlite"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it("saves the original half-startup failure before registered services and directories are reclaimed", async () => {
  const root = mkdtempSync(join(tmpdir(), "mate-evidence-startup-"));
  try {
    const failure = await runScenario({
      name: "half startup",
      evidenceRoot: root,
      provider: createScriptedProvider(),
      environment: { node: { heartbeatIntervalMs: 2000, heartbeatTimeoutMs: 100 } },
      run() {
        throw new Error("Startup must not reach the scenario body");
      },
    }).catch((error: unknown) => error);
    if (!(failure instanceof ScenarioFailure))
      throw new Error("Expected half-startup evidence failure");
    expect(String(failure.cause)).toContain("heartbeat timeout must be longer");
    const summary = JSON.parse(
      readFileSync(join(failure.evidenceDirectory, "summary.json"), "utf8"),
    );
    expect(summary.error.message).toContain("heartbeat timeout must be longer");
    const manifest = JSON.parse(
      readFileSync(join(failure.evidenceDirectory, "resources.json"), "utf8"),
    );
    expect(existsSync(manifest.directory)).toBe(false);
    expect(failure.cleanup.flatMap((report) => report.failures)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it("preserves the original error and summary when real Owner API collection stalls", async () => {
  const root = mkdtempSync(join(tmpdir(), "mate-evidence-stalled-"));
  const original = new Error("original failure before stopped API");
  try {
    const failure = await runScenario({
      name: "stalled real collection",
      evidenceRoot: root,
      provider: createScriptedProvider(),
      environment: { agents: [{ name: "停滞证据同事" }], cleanupTimeoutMs: 150 },
      async run({ environment, step }) {
        await step("ready before failure", () => ({ nodeId: environment.nodeId }));
        environment.beforeClose("resume only this stopped control plane", () => {
          environment.control.child.kill("SIGCONT");
        });
        environment.control.child.kill("SIGSTOP");
        throw original;
      },
    }).catch((error: unknown) => error);
    if (!(failure instanceof ScenarioFailure)) throw new Error("Expected stalled evidence failure");
    expect(failure.cause).toBe(original);
    const summary = JSON.parse(
      readFileSync(join(failure.evidenceDirectory, "summary.json"), "utf8"),
    );
    expect(summary).toMatchObject({
      name: "stalled real collection",
      error: { message: original.message },
      lastEvent: { name: "ready before failure" },
    });
    expect(
      failure.cleanup.flatMap((report) => report.failures).map((entry) => entry.resource),
    ).toContain("before close: scenario evidence");
    await waitForScenario(
      "original cleanup completes after evidence deadline",
      () => failure.close(),
      (report) => report.failures.length === 0,
      { timeoutMs: 5000 },
    );
    const manifest = JSON.parse(
      readFileSync(join(failure.evidenceDirectory, "resources.json"), "utf8"),
    );
    expect(existsSync(manifest.directory)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it("preserves public channel messages and every thread reply rather than only the recent preview", async () => {
  const root = mkdtempSync(join(tmpdir(), "mate-evidence-thread-"));
  const original = new Error("original collaborative evidence assertion");
  let channelId = "";
  try {
    const failure = await runScenario({
      name: "public thread evidence",
      evidenceRoot: root,
      provider: createScriptedProvider(),
      async run({ environment }) {
        const channel = await (
          await environment.request("/api/owner/channels", {
            method: "POST",
            body: { name: "合成公开讨论", description: "合成证据", visibility: "public" },
          })
        ).json();
        channelId = channel.id;
        const rootMessage = await (
          await environment.request(`/api/owner/channels/${channelId}/messages`, {
            method: "POST",
            body: { text: "synthetic root" },
          })
        ).json();
        for (let index = 0; index < 5; index++)
          await environment.request(`/api/owner/channels/${channelId}/messages`, {
            method: "POST",
            body: { text: `synthetic reply ${index}`, rootId: rootMessage.id },
          });
        throw original;
      },
    }).catch((error: unknown) => error);
    if (!(failure instanceof ScenarioFailure)) throw new Error("Expected channel evidence failure");
    expect(failure.cause).toBe(original);
    const channel = JSON.parse(
      readFileSync(join(failure.evidenceDirectory, `channel-${channelId}.json`), "utf8"),
    );
    expect(channel.threads[0].replies.map((reply: { text: string }) => reply.text)).toEqual([
      "synthetic reply 0",
      "synthetic reply 1",
      "synthetic reply 2",
      "synthetic reply 3",
      "synthetic reply 4",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it("exports node-local command and file receipts from real tool execution without copying its database", async () => {
  const root = mkdtempSync(join(tmpdir(), "mate-evidence-node-receipts-"));
  const original = new Error("original error after durable node receipts");
  let agentId = "";
  try {
    const provider = createScriptedProvider();
    const failure = await runScenario({
      name: "node receipts",
      evidenceRoot: root,
      provider,
      environment: { agents: [{ name: "本地收据同事" }] },
      async run({ environment, driver, effectFile }) {
        const agent = environment.agents[0];
        if (!agent) throw new Error("Expected prepared Agent");
        agentId = agent.summary.id;
        provider.forAgent(agent, [
          function writeInput(request: ScriptedRequest) {
            request.call("workspace.write", { path: "input.txt", content: "2\n4\n6\n" });
          },
          function consumeRealInput(request: ScriptedRequest) {
            request.call("process.exec", { command: "cat input.txt" });
          },
          function acknowledgeRealOutput(request: ScriptedRequest) {
            expect(
              request.result("process.exec", scriptedToolResultSchemas["process.exec"]).receipt
                ?.stdout,
            ).toBe("2\n4\n6\n");
            request.text("真实文件与命令已完成。");
          },
        ]);
        effectFile("input.txt", join(agent.workspace, "input.txt"));
        const target = await driver.sendOwnerMessage(agent, "写入并读回合成数值。");
        await driver.waitForRun(target, "completed");
        throw original;
      },
    }).catch((error: unknown) => error);
    if (!(failure instanceof ScenarioFailure))
      throw new Error("Expected node receipt evidence failure");
    expect(failure.cause).toBe(original);
    const node = JSON.parse(
      readFileSync(join(failure.evidenceDirectory, "node-facts.json"), "utf8"),
    );
    expect(node.operations).toEqual([expect.objectContaining({ agentId, state: "succeeded" })]);
    expect(JSON.parse(node.operations[0].receipt).stdout).toBe("2\n4\n6\n");
    expect(node.fileReceipts).toEqual([
      expect.objectContaining({
        agentId,
        state: "succeeded",
        result: expect.objectContaining({ code: 0 }),
      }),
    ]);
    expect(readdirSync(failure.evidenceDirectory).some((name) => name.includes("sqlite"))).toBe(
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it("reports a changed service identity without signalling that service or deleting its directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "mate-evidence-identity-"));
  try {
    await runScenario({
      name: "ownership refusal",
      evidenceRoot: root,
      provider: createScriptedProvider(),
      async run({ environment, evidenceDirectory }) {
        const manifest = JSON.parse(
          readFileSync(join(evidenceDirectory, "resources.json"), "utf8"),
        );
        // Reach the stale-service branch using only this fixture's copied manifest and processes.
        manifest.driverPid = 2147483647;
        manifest.processes = manifest.processes.filter(
          (entry: { service: string }) => entry.service === "control-plane",
        );
        manifest.processes[0].marker = `unowned ${manifest.processes[0].marker}`;
        const path = join(evidenceDirectory, "stale-resources.json");
        writeFileSync(path, JSON.stringify(manifest));
        const result = spawnSync(process.execPath, ["tests/helpers/scenario-cleanup.mjs", path], {
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(result.status).toBe(1);
        const report = JSON.parse(result.stdout).reports[0];
        expect(report.errors[0]).toContain("identity changed; no signal sent");
        expect(report.residual).toHaveLength(1);
        expect(environment.control.exitStatus).toBeUndefined();
        expect(existsSync(environment.directory)).toBe(true);
        expect((await fetch(environment.origin)).ok).toBe(true);
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

for (const mode of ["exited", "still starting"]) {
  it(`reclaims its real ${mode} node through the zombie holder lifecycle`, async () => {
    const root = mkdtempSync(join(tmpdir(), "mate-evidence-zombie-"));
    const directory = mkdtempSync(join(tmpdir(), "mate-scenario-zombie-"));
    const ownership = randomUUID();
    const entry = resolve("tests/helpers/scenario-services.mjs");
    const executable = join(root, "zombie-holder");
    const manifest = join(root, "resources.json");
    writeFileSync(join(directory, ".mate-scenario-owner"), ownership);
    let holder: ProcessOutput | undefined;
    let passed = false;
    let failed = false;
    let primaryError: unknown;
    try {
      execFileSync("cc", ["tests/fixtures/scenario-zombie-holder.c", "-o", executable], {
        timeout: 10_000,
      });
      holder = new ProcessOutput(
        spawn(executable, [process.execPath, entry, "node", ownership], {
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            MATE_NODE_DATA_DIR: join(directory, "node-data"),
            MATE_NODE_AGENT_WORKSPACE_ROOT: join(directory, "workspaces"),
            MATE_CONTROL_PLANE_URL: "http://127.0.0.1:1",
            MATE_SCENARIO_COMMAND_TIMEOUT_MS: "700",
            MATE_SCENARIO_HEARTBEAT_INTERVAL_MS: "25",
            MATE_SCENARIO_HEARTBEAT_TIMEOUT_MS: "100",
            ...(mode === "still starting" ? { MATE_NODE_PAIRING_TOKEN: randomUUID() } : {}),
          },
          stdio: ["pipe", "pipe", "pipe"],
        }),
      );
      const started = await holder.waitFor(/MATE_CHILD_STARTED (\d+)/);
      const pid = Number(started[1]);
      writeFileSync(
        manifest,
        JSON.stringify({
          version: 1,
          directory,
          ownership,
          // The holder observes the service, rather than driving a Mate scenario.
          driverPid: 2147483647,
          processes: [{ service: "node", pid, marker: `${entry} node ${ownership}` }],
        }),
      );
      if (mode === "still starting") {
        await holder.waitFor(/Node WebSocket connection failed; retrying/);
        expect(process.kill(pid, 0)).toBe(true);
        expect(
          execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim(),
        ).not.toMatch(/^Z/);
        holder.child.kill("SIGTERM");
        const observed = holder;
        await waitForScenario(
          "holder terminates during service preparation",
          () => observed.exitStatus,
          (status) => status !== undefined,
          { timeoutMs: 2000 },
        );
        expect(() => process.kill(pid, 0)).toThrow();
        expect(holder.exitStatus).toEqual({ code: 0, signal: null });
      } else {
        const ready = await holder.waitFor(/MATE_ZOMBIE_READY (\d+) (\d+)/);
        expect(Number(ready[1])).toBe(pid);
        expect(Number(ready[2])).toBe(1);
        expect(holder.text).toContain("A new Linux node requires MATE_NODE_PAIRING_TOKEN");
        // WNOWAIT guarantees an exited, unreaped real Node; kill(0) alone still sees its PID.
        expect(process.kill(pid, 0)).toBe(true);
        expect(
          execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim(),
        ).toMatch(/^Z/);
        const result = spawnSync(
          process.execPath,
          ["tests/helpers/scenario-cleanup.mjs", manifest],
          {
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        writeFileSync(join(root, "independent-cleanup-initial.json"), result.stdout);
        expect(result.status, `Initial zombie cleanup: ${result.stdout}\n${result.stderr}`).toBe(0);
        const report = JSON.parse(result.stdout).reports[0];
        expect(report.residual).toEqual([]);
        expect(report.observations).toContainEqual(
          expect.objectContaining({
            pid,
            state: expect.stringMatching(/^Z/),
            identityMatches: false,
          }),
        );
        expect(report.signals).toEqual([]);
        expect(existsSync(directory)).toBe(false);
        expect(process.kill(pid, 0)).toBe(true);
      }
      passed = true;
    } catch (error) {
      failed = true;
      primaryError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (holder) {
        try {
          holder.child.stdin?.end("release");
          const observed = holder;
          await waitForScenario(
            "zombie holder reaps its child",
            () => observed.exitStatus,
            (status) => status !== undefined,
            { timeoutMs: 2000 },
          );
          expect(holder.exitStatus).toEqual({ code: 0, signal: null });
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await stopProcess(holder);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        if (existsSync(manifest)) {
          const result = spawnSync(
            process.execPath,
            ["tests/helpers/scenario-cleanup.mjs", manifest],
            {
              encoding: "utf8",
              timeout: 10_000,
            },
          );
          if (result.status !== 0)
            throw new Error(`Fixture cleanup: ${result.stdout}\n${result.stderr}`);
        } else rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (passed && !cleanupErrors.length) {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (!passed || cleanupErrors.length) {
        console.error(`MATE_SCENARIO_PROBE_RETAINED ${root}`, holder?.text);
        try {
          writeFileSync(
            join(root, "fixture-cleanup-errors.json"),
            JSON.stringify(cleanupErrors.map(String)),
          );
          writeFileSync(
            join(root, "fixture-failure.json"),
            JSON.stringify({ error: String(primaryError) }),
          );
          writeFileSync(join(root, "fixture-output.txt"), holder?.text ?? "holder not started");
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length) {
        console.error(`MATE_SCENARIO_PROBE_CLEANUP_FAILED ${root}`, cleanupErrors);
        if (!failed) throw new AggregateError(cleanupErrors, "Zombie fixture cleanup failed");
      }
    }
  }, 30_000);
}
