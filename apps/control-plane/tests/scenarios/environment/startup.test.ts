import { chmodSync, existsSync, rmSync } from "node:fs";

import { expect, it } from "vitest";

import { respond } from "../../support/agent/agent-loop.js";

import {
  createScenarioEnvironment,
  ScenarioStartupError,
} from "../../support/environment/scenario-environment.js";

it("cancels immediately while the provider is still binding without losing the cancellation cause", async () => {
  const controller = new AbortController();
  const reason = new Error("Cancelled before local provider listening");
  const starting = createScenarioEnvironment({ signal: controller.signal, provider: () => {} });
  controller.abort(reason);
  try {
    await starting;
    throw new Error("Immediate cancellation unexpectedly started");
  } catch (error) {
    if (!(error instanceof ScenarioStartupError)) throw error;
    expect(error.cause).toBe(reason);
    expect(error.processes).toEqual([]);
    expect(existsSync(error.directory)).toBe(false);
    expect(error.cleanupReports.flatMap((report) => report.failures)).toEqual([]);
    expect(await error.close()).toEqual({ released: [], failures: [] });
  }
}, 30_000);

it("does not replace a scenario resource whose display name matches a later node process", async () => {
  const environment = await createScenarioEnvironment({ provider: () => {} });
  let released = false;
  try {
    environment.registerCleanup("node process 3", () => {
      released = true;
    });
    await environment.restartNode();
    expect((await environment.close()).failures).toEqual([]);
    expect(released).toBe(true);
    expect(environment.resources).toEqual([]);
  } finally {
    await environment.close();
  }
}, 30_000);

it("rejects overlapping service restarts without creating duplicate same-identity processes", async () => {
  const environment = await createScenarioEnvironment({ provider: () => {} });
  try {
    for (const restart of [environment.restartNode, environment.restartControl]) {
      const results = await Promise.allSettled([restart(), restart()]);
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect(results[1]).toEqual({
        status: "rejected",
        reason: expect.objectContaining({
          message: "Scenario service restart already in progress",
        }),
      });
      expect(
        environment.processes.filter((output) => output.exitStatus === undefined),
      ).toHaveLength(2);
    }
  } finally {
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30_000);

it("retains a retryable lifecycle when startup cleanup cannot initially remove its private directory", async () => {
  let failure: ScenarioStartupError | undefined;
  try {
    await createScenarioEnvironment({
      provider: () => {},
      node: { heartbeatIntervalMs: 2000, heartbeatTimeoutMs: 100 },
      beforeClose(facts) {
        chmodSync(facts.directory, 0o500);
      },
    });
    throw new Error("Invalid node configuration unexpectedly started");
  } catch (error) {
    if (!(error instanceof ScenarioStartupError)) throw error;
    failure = error;
    expect(String(error.cause)).toContain("heartbeat timeout must be longer");
    expect(error.cleanup.failures).toEqual([
      { resource: "synthetic directory", error: expect.any(Error) },
    ]);
    expect(error.processes.every((output) => output.exitStatus !== undefined)).toBe(true);
    chmodSync(error.directory, 0o700);
    expect(await error.close()).toEqual({ released: ["synthetic directory"], failures: [] });
    expect(existsSync(error.directory)).toBe(false);
  } finally {
    if (failure && existsSync(failure.directory)) {
      chmodSync(failure.directory, 0o700);
      rmSync(failure.directory, { recursive: true, force: true });
    }
  }
}, 30_000);

it("cancels startup after an observed real control-plane listening event and preserves evidence before cleanup", async () => {
  const controller = new AbortController();
  const reason = new Error("Synthetic startup cancellation");
  let capturedBeforeRemoval = false;
  try {
    await createScenarioEnvironment({
      signal: controller.signal,
      provider: () => {},
      observeProcess(service, output) {
        if (service === "control-plane")
          void output.waitFor(/MATE_CONTROL_PLANE_LISTENING/).then(() => controller.abort(reason));
      },
      beforeClose(facts) {
        capturedBeforeRemoval =
          existsSync(facts.directory) &&
          facts.processes.length === 1 &&
          facts.processes[0]?.exitStatus === undefined;
      },
    });
    throw new Error("Cancelled startup unexpectedly completed");
  } catch (error) {
    if (!(error instanceof ScenarioStartupError)) throw error;
    expect(error.cause).toBe(reason);
    expect(capturedBeforeRemoval).toBe(true);
    expect(error.processes).toHaveLength(1);
    expect(error.processes[0]?.exitStatus).toBeDefined();
    expect(error.cleanup.failures).toEqual([]);
    expect(existsSync(error.directory)).toBe(false);
  }
}, 30_000);

it("cleans every registered real service when node startup fails after control-plane login", async () => {
  try {
    await createScenarioEnvironment({
      provider: (_request, response) => respond(response, "静默。"),
      node: { heartbeatIntervalMs: 2000, heartbeatTimeoutMs: 100 },
      beforeClose() {
        throw new Error("Synthetic evidence failure");
      },
    });
    throw new Error("Invalid heartbeat configuration unexpectedly started");
  } catch (error) {
    if (!(error instanceof ScenarioStartupError)) throw error;
    expect(error.cause).toBeInstanceOf(Error);
    expect(String(error.cause)).toContain("heartbeat timeout must be longer");
    expect(error.processes).toHaveLength(2);
    expect(error.processes.every((output) => output.exitStatus !== undefined)).toBe(true);
    expect(error.cleanup.failures).toEqual([
      {
        resource: "before close: scenario evidence",
        error: expect.objectContaining({ message: "Synthetic evidence failure" }),
      },
    ]);
    expect(existsSync(error.directory)).toBe(false);
  }
}, 30_000);
