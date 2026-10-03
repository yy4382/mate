import { execFileSync } from "node:child_process";

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runScenario, ScenarioFailure } from "../../support/scenario/scenario-evidence.js";
import {
  createScriptedProvider,
  type ScriptedRequest,
} from "../../support/agent/scripted-provider.js";
import { waitForScenario } from "../../support/scenario/scenario-driver.js";

import { scriptedToolResultSchemas } from "../../support/agent/scripted-tool-results.js";

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
