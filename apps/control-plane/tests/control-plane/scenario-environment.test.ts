import { chmodSync, existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { agentSummarySchema, nodeSummarySchema } from "@mate/protocol/owner";
import { respond } from "../helpers/agent-loop.js";
import { eventually } from "../helpers/run-services.js";
import { createServer } from "node:http";
import {
  createScenarioEnvironment,
  ScenarioStartupError,
} from "../helpers/scenario-environment.js";
import { release } from "node:os";

console.info(
  "SCENARIO_ENVIRONMENT_PLATFORM",
  JSON.stringify({
    platform: process.platform,
    kernel: release(),
    arch: process.arch,
    node: process.version,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
  }),
);

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

it("waits for a timed-out release still finishing cancellation instead of invoking it concurrently", async () => {
  const environment = await createScenarioEnvironment({
    provider: () => {},
    cleanupTimeoutMs: 1000,
  });
  let finishRelease = () => {};
  const releaseFinishing = new Promise<void>((resolve) => {
    finishRelease = resolve;
  });
  let finishObserved = () => {};
  const releaseFinished = new Promise<void>((resolve) => {
    finishObserved = resolve;
  });
  let attempts = 0;
  let active = 0;
  let abortObserved = false;
  try {
    environment.registerCleanup("finishing cancellation", (signal) => {
      attempts++;
      active++;
      signal.addEventListener(
        "abort",
        () => {
          abortObserved = true;
        },
        { once: true },
      );
      return releaseFinishing.finally(() => {
        active--;
        finishObserved();
      });
    });
    for (let close = 0; close < 2; close++) {
      const report = await environment.close();
      expect(report.failures.map((failure) => failure.resource)).toEqual([
        "finishing cancellation",
      ]);
      expect(environment.resources).toEqual(["finishing cancellation"]);
    }
    expect(abortObserved).toBe(true);
    expect(attempts).toBe(1);
    expect(active).toBe(1);
    finishRelease();
    await releaseFinished;
    expect(await environment.close()).toEqual({
      released: ["finishing cancellation"],
      failures: [],
    });
    expect(attempts).toBe(1);
    expect(active).toBe(0);
  } finally {
    finishRelease();
    await releaseFinished;
    await environment.close();
  }
}, 30_000);

it("bounds stalled evidence and resource callbacks, cleans other services, and retries the unreleased resource", async () => {
  const environment = await createScenarioEnvironment({
    provider: () => {},
    cleanupTimeoutMs: 1000,
  });
  let attempts = 0;
  let evidenceCancelled = false;
  try {
    environment.beforeClose(
      "stalled evidence",
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              evidenceCancelled = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    environment.registerCleanup("stalled release", (signal) => {
      if (++attempts > 1) return;
      return new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    const report = await environment.close();
    expect(report.failures.map((failure) => failure.resource)).toEqual([
      "before close: stalled evidence",
      "stalled release",
    ]);
    expect(evidenceCancelled).toBe(true);
    expect(environment.processes.every((output) => output.exitStatus !== undefined)).toBe(true);
    expect(existsSync(environment.directory)).toBe(false);
    expect(environment.resources).toEqual(["stalled release"]);
    expect(await environment.close()).toEqual({ released: ["stalled release"], failures: [] });
    expect(attempts).toBe(2);
  } finally {
    await environment.close();
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

it("prepares a real logged-in paired Agent whose Pi run can execute an ordinary node command", async () => {
  const environment = await createScenarioEnvironment({
    agents: [{ name: "场景同事" }],
    provider(request, response) {
      if (
        request.input.some(
          (item) => item.type === "function_call_output" && item.output.includes("command-ran"),
        )
      )
        respond(response, "完成。");
      else
        respond(response, [
          {
            name: "tools.call",
            input: {
              name: "process.exec",
              input: { command: "printf 'command-ran' > result.txt; cat result.txt" },
            },
          },
        ]);
    },
  });
  try {
    const agent = environment.agents[0]!;
    expect(agent.summary.status).toBe("ready");
    await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
      method: "POST",
      body: { text: "执行普通命令。" },
    });
    await eventually(
      () =>
        existsSync(join(agent.workspace, "result.txt")) &&
        environment.requests.some((request) =>
          request.input.some(
            (item) => item.type === "function_call_output" && item.output.includes("command-ran"),
          ),
        )
          ? true
          : undefined,
      "real command file and model-visible result",
    );
    expect(readFileSync(join(agent.workspace, "result.txt"), "utf8")).toBe("command-ran");
  } finally {
    expect((await environment.close()).failures).toEqual([]);
  }
  expect(existsSync(environment.directory)).toBe(false);
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

it.each(["SIGINT", "SIGTERM"])(
  "releases its real services on driver %s cancellation",
  async (signal) => {
    const environment = await createScenarioEnvironment({ provider: () => {} });
    let received = false;
    const guard = () => {
      received = true;
    };
    // Keep a failing test alive so its finally can clean up the actual services.
    process.on(signal, guard);
    try {
      process.kill(process.pid, signal);
      await eventually(
        () =>
          received &&
          environment.processes.every((output) => output.exitStatus !== undefined) &&
          !existsSync(environment.directory)
            ? true
            : undefined,
        `${signal} cleanup`,
        2000,
      );
      expect(environment.cleanupReports.at(-1)?.failures).toEqual([]);
      expect(environment.resources).toEqual([]);
    } finally {
      await environment.close();
      process.removeListener(signal, guard);
    }
  },
  30_000,
);

it("records a release failure separately, still closes all other resources, and retries it on repeated close", async () => {
  const environment = await createScenarioEnvironment({ provider: () => {} });
  const extra = createServer((_request, response) => response.end("registered-resource"));
  let releaseAttempts = 0;
  await new Promise<void>((done) => extra.listen(0, "127.0.0.1", done));
  const address = extra.address();
  if (!address || typeof address === "string") throw new Error("Extra test server has no port");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    environment.registerCleanup("extra server", async () => {
      if (++releaseAttempts === 1) throw new Error("Synthetic single release failure");
      extra.closeAllConnections();
      await new Promise<void>((done, reject) =>
        extra.close((error) => (error ? reject(error) : done())),
      );
    });
    let observedBeforeRelease = false;
    environment.beforeClose("observe resources", async () => {
      observedBeforeRelease =
        existsSync(environment.directory) &&
        environment.processes.every((output) => output.exitStatus === undefined);
      expect((await environment.request("/api/status")).ok).toBe(true);
    });
    const first = await environment.close();
    expect(observedBeforeRelease).toBe(true);
    expect(first.failures).toEqual([
      {
        resource: "extra server",
        error: expect.objectContaining({ message: "Synthetic single release failure" }),
      },
    ]);
    expect(first.released).toEqual(
      expect.arrayContaining(["local provider", "synthetic directory"]),
    );
    expect(environment.processes.every((output) => output.exitStatus !== undefined)).toBe(true);
    expect(existsSync(environment.directory)).toBe(false);
    expect(await (await fetch(url)).text()).toBe("registered-resource");
    expect(await environment.close()).toEqual({ released: ["extra server"], failures: [] });
    expect(await environment.close()).toEqual({ released: [], failures: [] });
    expect(releaseAttempts).toBe(2);
  } finally {
    await environment.close();
    extra.closeAllConnections();
    if (extra.listening) await new Promise<void>((done) => extra.close(() => done()));
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

it("runs real commands under the existing account with synthetic HOME and no inherited provider credentials", async () => {
  const originalCredential = process.env.OPENAI_API_KEY;
  const originalCanary = process.env.MATE_PARENT_ONLY_CANARY;
  process.env.OPENAI_API_KEY = "synthetic-parent-provider-canary";
  process.env.MATE_PARENT_ONLY_CANARY = "synthetic-parent-environment-canary";
  let environment: Awaited<ReturnType<typeof createScenarioEnvironment>> | undefined;
  try {
    environment = await createScenarioEnvironment({
      agents: [{ name: "环境边界同事" }],
      provider(request, response) {
        if (request.input.some((item) => item.type === "function_call_output"))
          respond(response, "完成。");
        else
          respond(response, [
            {
              name: "tools.call",
              input: {
                name: "process.exec",
                input: {
                  command: `node -e 'process.stdout.write(JSON.stringify({uid:process.getuid(),gid:process.getgid(),home:process.env.HOME,cwd:process.cwd(),providerCredential:!!process.env.OPENAI_API_KEY,parentCanary:!!process.env.MATE_PARENT_ONLY_CANARY}))' > account.json; cat account.json`,
                },
              },
            },
          ]);
      },
    });
    const agent = environment.agents[0]!;
    await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
      method: "POST",
      body: { text: "读取合成环境的账号和 HOME。" },
    });
    await eventually(
      () =>
        existsSync(join(agent.workspace, "account.json")) &&
        readFileSync(join(agent.workspace, "account.json")).length > 0
          ? true
          : undefined,
      "account environment result",
    );
    const result = JSON.parse(readFileSync(join(agent.workspace, "account.json"), "utf8"));
    expect(result).toEqual({
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      home: agent.workspace,
      cwd: realpathSync(agent.workspace),
      providerCredential: false,
      parentCanary: false,
    });
  } finally {
    await environment?.close();
    if (originalCredential === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalCredential;
    if (originalCanary === undefined) delete process.env.MATE_PARENT_ONLY_CANARY;
    else process.env.MATE_PARENT_ONLY_CANARY = originalCanary;
  }
}, 30_000);

it("keeps two parallel environments independent when one closes and the other executes a real tool", async () => {
  const [first, second] = await Promise.all([
    createScenarioEnvironment({
      agents: [{ name: "第一位" }],
      provider: (_request, response) => respond(response, "静默。"),
    }),
    createScenarioEnvironment({
      agents: [{ name: "第二位" }],
      provider(request, response) {
        if (request.input.some((item) => item.type === "function_call_output"))
          respond(response, "完成。");
        else
          respond(response, [
            {
              name: "tools.call",
              input: {
                name: "process.exec",
                input: { command: "printf 'second-alive' > second.txt; cat second.txt" },
              },
            },
          ]);
      },
    }),
  ]);
  try {
    expect(first.origin).not.toBe(second.origin);
    expect(first.directory).not.toBe(second.directory);
    expect(first.nodeId).not.toBe(second.nodeId);
    expect((await first.close()).failures).toEqual([]);
    expect(existsSync(first.directory)).toBe(false);
    const agent = second.agents[0]!;
    const listed = z
      .object({ agents: z.array(agentSummarySchema) })
      .parse(await (await second.request("/api/owner/agents")).json());
    expect(listed.agents.map((entry) => entry.id)).toEqual([agent.summary.id]);
    await second.request(`/api/owner/channels/${agent.channelId}/messages`, {
      method: "POST",
      body: { text: "第一套已关闭，继续真实工作。" },
    });
    await eventually(
      () => (existsSync(join(agent.workspace, "second.txt")) ? true : undefined),
      "second environment tool",
    );
    expect(readFileSync(join(agent.workspace, "second.txt"), "utf8")).toBe("second-alive");
    expect(second.processes.every((output) => output.exitStatus === undefined)).toBe(true);
  } finally {
    expect((await first.close()).failures).toEqual([]);
    expect((await second.close()).failures).toEqual([]);
  }
}, 30_000);

it("restarts the same control plane and node using the original node identity, workspace and Agent session", async () => {
  const environment = await createScenarioEnvironment({
    agents: [{ name: "接续同事" }],
    provider: (_request, response) => respond(response, "静默完成。"),
  });
  try {
    const agent = environment.agents[0]!;
    const originalIdentity = readFileSync(
      join(environment.directory, "node-data", "node-identity.json"),
    );
    const originalMemory = readFileSync(join(agent.workspace, "MEMORY.md"));
    await environment.restartNode();
    await environment.restartControl();
    const nodes = z
      .object({ nodes: z.array(nodeSummarySchema) })
      .parse(await (await environment.request("/api/owner/nodes")).json());
    expect(nodes.nodes).toEqual([
      expect.objectContaining({ id: environment.nodeId, online: true }),
    ]);
    const listed = z
      .object({ agents: z.array(agentSummarySchema) })
      .parse(await (await environment.request("/api/owner/agents")).json());
    expect(listed.agents).toEqual([
      expect.objectContaining({
        id: agent.summary.id,
        sessionId: agent.summary.sessionId,
        linuxIdentity: expect.objectContaining({ workspace: agent.workspace }),
      }),
    ]);
    expect(readFileSync(join(environment.directory, "node-data", "node-identity.json"))).toEqual(
      originalIdentity,
    );
    expect(readFileSync(join(agent.workspace, "MEMORY.md"))).toEqual(originalMemory);
    expect(environment.processes).toHaveLength(4);
  } finally {
    expect((await environment.close()).failures).toEqual([]);
  }
}, 30_000);
