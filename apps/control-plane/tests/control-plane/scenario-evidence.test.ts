import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
      environment: { agents: [{ name: "信号证据同事" }] },
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

for (const mode of ["timeout", "SIGINT", "SIGTERM", "SIGKILL"]) {
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
      if (mode === "SIGKILL") {
        expect(existsSync(join(directory, "summary.json"))).toBe(false);
        expect((await fetch(ready.origin)).ok).toBe(true);
        const result = JSON.parse(
          execFileSync(
            process.execPath,
            ["tests/helpers/scenario-cleanup.mjs", join(directory, "resources.json")],
            { encoding: "utf8", timeout: 15_000 },
          ),
        );
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
    } finally {
      await stopProcess(probe);
      if (probe.text.includes("Error")) console.error(probe.text);
      // Only this test's manifests, never a global scan/prune. Also handles an early parent assertion failure.
      execFileSync(process.execPath, ["tests/helpers/scenario-cleanup.mjs", "--root", root], {
        encoding: "utf8",
        timeout: 15_000,
      });
      rmSync(root, { recursive: true, force: true });
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
