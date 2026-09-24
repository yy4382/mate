import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../../src/storage/store.js";
import { configSchema } from "../../src/config.js";
import { configFixture } from "../helpers/config.js";
import { Messages, Output, fixtureTarget } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { CanonicalAttention } from "../../src/conversations/attention.js";
import { CanonicalFreshnessGate } from "../../src/conversations/freshness.js";
import { Broker } from "../../src/policy/broker.js";
import { FairAdmission } from "../../src/concurrency/admission.js";
import { WorkerClient } from "../../src/runtime/client.js";
import { Supervisor, type Worker } from "../../src/runtime/supervisor.js";
import { ToolRouter } from "../../src/runtime/tools.js";
import {
  abortFault,
  faultError,
  modelFault,
  type FaultCategory,
  type FaultStage,
  type WorkerFault,
} from "../../src/runtime/fault.js";
import { resumeAction, resumeDelayMs } from "../../src/runtime/resume.js";
import { answer, deferred } from "../helpers/pi.js";
import { providerId } from "../helpers/fault-model.js";

const fault = (stage: FaultStage, category: FaultCategory, reason: string): WorkerFault => ({
  stage,
  category,
  reason,
});
/** Exactly the value a real worker's `failed` envelope carries for a transient provider failure. */
const transient = () => faultError(fault("model", "transient_model", "provider rate limited"));
/**
 * The reason names where the failure came from. How much of the raising text survives after that is
 * the shared reason filter's contract (`api key <value>` becomes `api key [redacted]`), so only the
 * stage/category prefix and a non-empty remainder are asserted here.
 */
function expectReason(action: { reason: string }, failure: WorkerFault): void {
  const origin = `${failure.stage}/${failure.category}: `;
  expect(action.reason.startsWith(origin)).toBe(true);
  expect(action.reason.length).toBeGreaterThan(origin.length);
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups.splice(0).forEach((fn) => fn());
});

it("grows the interval after each transient failure and caps it", () => {
  // A growing, capped interval: the first attempts double from one second, and no attempt waits
  // longer than a minute, so a long provider outage costs one attempt per minute per Agent.
  expect([1, 2, 3, 4, 5, 6, 7, 8].map(resumeDelayMs)).toEqual([
    1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
  ]);
  // An absent or nonsensical attempt count is the first attempt, never a zero-length wait or NaN.
  for (const attempt of [0, -3, 1.5, Number.NaN]) expect(resumeDelayMs(attempt)).toBe(1000);
  expect(resumeDelayMs(5000)).toBe(60000);
});

it("retries only a genuinely transient model failure, on the growing interval", () => {
  const failure = fault("model", "transient_model", "provider rate limited"),
    first = resumeAction(failure, 0, 5_000),
    fourth = resumeAction(failure, 3, 5_000);
  expect(first).toMatchObject({ kind: "retry", attempt: 1, nextAt: 6_000 });
  expect(fourth).toMatchObject({ kind: "retry", attempt: 4, nextAt: 13_000 });
  expectReason(first, failure);
  expectReason(fourth, failure);
  // A wait already in the future is what the persisted attempt count reproduces after a restart.
  expect(resumeAction(failure, 7, 5_000)).toMatchObject({ attempt: 8, nextAt: 65_000 });
});

it("holds every failure a person has to judge, and adds no hold to a deliberate stop", () => {
  const cases: [WorkerFault, string][] = [
    [fault("model", "credential_config", "invalid api key provided"), "human_action"],
    [
      fault("execution", "unknown_effect", "the external effect could not be confirmed"),
      "verify_effect",
    ],
    [fault("persistence", "shared_persistence", "durable record write failed"), "no_retry"],
    [fault("tool", "definite_tool_refusal", "the operation was refused"), "no_retry"],
  ];
  for (const [failure, hold] of cases) {
    const action = resumeAction(failure, 2, 5_000);
    expect(action.kind).toBe("hold");
    expect(action).toMatchObject({ hold });
    expectReason(action, failure);
  }
  // A run stopped on purpose — a person's stop, a work stop, or this process shutting down — is
  // reported as an abort. It must not become a hold a human has to release, or that stop would
  // become permanent instead of the delivery waiting for the next run of the same channel.
  const stopped = abortFault("the run was aborted before the worker finished");
  const action = resumeAction(stopped, 2, 5_000);
  expect(action.kind).toBe("none");
  expectReason(action, stopped);

  // The model boundary reporting an aborted call is not somebody's decision: the provider stream
  // ended without an answer, so that call waits out the interval like any unexplained model fault
  // instead of bypassing the backoff and retrying on the next scheduler tick.
  const providerAbort = modelFault("aborted", "connection aborted while reading");
  const retried = resumeAction(providerAbort, 1, 5_000);
  expect(retried).toMatchObject({ kind: "retry", attempt: 2, nextAt: 7_000 });
  expectReason(retried, providerAbort);
});

/** Two Agents sharing one work item, with one run slot so a waiting Agent must not hold it. */
function setup(
  factory: (agentId: string) => Worker,
  reference: () => Promise<string> = async () => "",
) {
  const config = configSchema.parse({
    ...configFixture,
    agents: [
      configFixture.agents[0],
      {
        ...configFixture.agents[0],
        id: "writer",
        name: "Writer",
        slackAppId: "ATWO",
        slackUserId: "UTWO",
        slackBotId: "BTWO",
        botTokenEnv: "WRITER_BOT",
        appTokenEnv: "WRITER_APP",
      },
    ],
  });
  const store = new Store(":memory:"),
    messages = new Messages(store, config);
  const attention = new CanonicalAttention(messages),
    output = new Output(
      messages,
      { post: async () => ({ ts: "100.000002" }) },
      Date.now,
      new CanonicalFreshnessGate(messages, attention),
    ),
    collaboration = new Collaboration(store, messages, output, config, attention);
  const broker = new Broker(
    store,
    collaboration,
    { execute: async () => ({ code: 0, stdout: "", stderr: "", truncated: false }) },
    { research: "/tmp", writer: "/tmp" },
  );
  const router = new ToolRouter(collaboration, broker);
  const admission = new FairAdmission(1);
  const supervisor = new Supervisor(
    collaboration,
    router,
    config,
    (agent) => factory(agent.id),
    reference,
    { runAdmission: admission },
  );
  supervisor.register();
  for (const agent of config.agents)
    for (const channel of ["CTEST", "CTWO"]) messages.membership(agent.id, channel, true);
  const work = collaboration.createWork("human:one", fixtureTarget("CTEST", "100.000001"));
  cleanups.push(() => {
    supervisor.close();
    store.close();
  });
  return { config, store, collaboration, supervisor, router, work, admission };
}
function usageRows(store: Store, agentId: string) {
  return store.db
    .prepare(
      "SELECT m.state,m.total_tokens FROM model_usage m JOIN runs r ON r.id=m.run_id WHERE r.agent_id=? ORDER BY r.created_at,m.call_index",
    )
    .all(agentId);
}
/** The active attempt's own token, as the supervisor holds it while the worker runs. */
function activeRun(store: Store) {
  const row = store.db
    .prepare("SELECT id,agent_id,session_id,generation,delivery_id FROM runs WHERE state='active'")
    .get() as {
    id: string;
    agent_id: string;
    session_id: string;
    generation: number;
    delivery_id: string;
  };
  return {
    id: row.id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    generation: row.generation,
    deliveryId: row.delivery_id,
  };
}
function runRows(store: Store, agentId = "research") {
  return store.db
    .prepare(
      "SELECT state,stop_reason stopReason,created_at FROM runs WHERE agent_id=? ORDER BY rowid",
    )
    .all(agentId) as { state: string; stopReason: string; created_at: number }[];
}

it("waits out a growing interval before retrying, without pausing or holding the run slot", async () => {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let created = 0;
  const attempts = new Map<string, number>(),
    specs: import("../../src/runtime/engine.js").RunSpec[] = [];
  const {
    store,
    collaboration: c,
    supervisor,
    work,
    admission,
  } = setup((agentId) => {
    if (agentId === "research") created++;
    return {
      close() {},
      async run(spec, hooks) {
        if (agentId !== "research")
          return { tokens: 1, cost: 0, certain: true, waiting: false, continuation: false };
        specs.push(spec);
        const attempt = (attempts.get(agentId) ?? 0) + 1;
        attempts.set(agentId, attempt);
        await hooks.usageBegin?.(1, "openai", "synthetic");
        if (attempt < 3) throw transient();
        await hooks.usageComplete?.(1, answer([]));
        return { tokens: 12, cost: 0, certain: true, waiting: false, continuation: false };
      },
    };
  });
  const delivery = c.enqueue("research", work, "transient", { text: "recover me" });
  expect(await supervisor.step("research")).toBe(true);
  // The attempt failed, the work did not: the Agent stays runnable and its wait is persisted.
  expect(store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({
    paused: 0,
  });
  expect(store.delivery(delivery).status).toBe("injected");
  expect(store.resumeState("research")).toEqual({
    attempt: 1,
    nextAttemptAt: now + 1000,
    hold: "retry_backoff",
  });
  expect(usageRows(store, "research")).toEqual([{ state: "unknown", total_tokens: null }]);
  // Waiting occupies no run slot at all, so another Agent proceeds and a queued run is not blocked.
  expect(await supervisor.step("research")).toBe(false);
  expect(admission.snapshot()).toEqual({ active: 0, queued: 0, limit: 1 });
  c.enqueue("writer", work, "writer-work", {});
  expect(await supervisor.step("writer")).toBe(true);
  // The stored next attempt time is respected, and the second failure doubles the interval.
  now += 999;
  expect(await supervisor.step("research")).toBe(false);
  expect(created).toBe(1);
  now += 1;
  expect(await supervisor.step("research")).toBe(true);
  expect(store.resumeState("research")).toEqual({
    attempt: 2,
    nextAttemptAt: now + 2000,
    hold: "retry_backoff",
  });
  expect(await supervisor.step("research")).toBe(false);
  now += 2000;
  expect(await supervisor.step("research")).toBe(true);
  expect(created).toBe(3);
  // The third attempt finished the work, so the Agent is healthy again.
  expect(store.delivery(delivery).status).toBe("handled");
  expect(store.resumeState("research")).toEqual({ attempt: 0, nextAttemptAt: 0, hold: null });
  expect(store.runnable("research", now)).toBe(true);
  // The retry kept the durable input and was told to resume rather than to start over.
  expect(JSON.stringify(specs[2]!.messages)).toContain("recover me");
  expect(JSON.stringify(specs[2]!.messages)).toContain("Resume the interrupted inbox delivery");
  // The failed calls stay recorded as unknown usage; the retry's own call is known.
  expect(usageRows(store, "research")).toEqual([
    { state: "unknown", total_tokens: null },
    { state: "unknown", total_tokens: null },
    { state: "known", total_tokens: 12 },
  ]);
});

it("a real worker process reporting a transient fault schedules the retry instead of pausing", async () => {
  let now = 2_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const {
    store,
    collaboration: c,
    supervisor,
    work,
  } = setup(
    () =>
      new WorkerClient(
        providerId,
        "synthetic",
        "key",
        new URL("../../dist/tests/helpers/fault-worker.js", import.meta.url),
        { MATE_FAULT_SCENARIO: "transient" },
      ),
  );
  const delivery = c.enqueue("research", work, "transient", {});
  expect(await supervisor.step("research")).toBe(true);
  // The classification crossed the real process boundary, so the schedule is the transient one.
  expect(store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({
    paused: 0,
  });
  const first = store.resumeState("research");
  expect(first).toEqual({ attempt: 1, nextAttemptAt: now + 1000, hold: "retry_backoff" });
  expect(first.hold).toBe("retry_backoff");
  expect(store.delivery(delivery).status).toBe("injected");
  expect(await supervisor.step("research")).toBe(false);
  now += 1000;
  expect(await supervisor.step("research")).toBe(true);
  expect(store.resumeState("research")).toMatchObject({
    attempt: 2,
    nextAttemptAt: now + 2000,
  });
}, 30000);

it("pauses only the Agent whose credential failed and keeps every other Agent working", async () => {
  const {
    store,
    collaboration: c,
    supervisor,
    work,
  } = setup((agentId) => ({
    close() {},
    async run() {
      if (agentId === "research")
        throw faultError(fault("model", "credential_config", "invalid api key provided"));
      return { tokens: 1, cost: 0, certain: true, waiting: false, continuation: false };
    },
  }));
  const affected = c.enqueue("research", work, "credential", {});
  const peer = c.enqueue("writer", work, "peer", {});
  expect(await supervisor.step("research")).toBe(true);
  // The affected Agent is paused for a person, with the disposition that names their next action.
  expect(store.resumeState("research")).toEqual({
    attempt: 0,
    nextAttemptAt: 0,
    hold: "human_action",
  });
  expect(store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({
    paused: 1,
  });
  expect(store.runnable("research", Date.now())).toBe(false);
  expect(store.delivery(affected).status).toBe("injected");
  // The failure is local to that Agent: the peer's own channel still runs and completes.
  expect(await supervisor.step("writer")).toBe(true);
  expect(store.delivery(peer).status).toBe("handled");
  expect(store.runnable("writer", Date.now())).toBe(true);
});

it("holds an Agent whose started effect cannot be judged safe to retry, with the verification action", async () => {
  const {
    store,
    collaboration: c,
    supervisor,
    work,
  } = setup(() => ({
    close() {},
    async run() {
      // An effect really is in flight when the attempt ends: it started and never recorded a
      // result, so the durable record has to keep it unknown rather than as never executed.
      store.prepareAction(activeRun(store), "in-flight", {
        operation: { kind: "exec", command: "synthetic" },
      });
      store.startAction(activeRun(store), "in-flight");
      throw faultError(
        fault("execution", "unknown_effect", "the external effect could not be confirmed"),
      );
    },
  }));
  const delivery = c.enqueue("research", work, "unsafe", {});
  expect(await supervisor.step("research")).toBe(true);
  expect(store.delivery(delivery).status).toBe("injected");
  expect(store.action("in-flight")?.state).toBe("unknown");
  expect(store.resumeState("research")).toEqual({
    attempt: 0,
    nextAttemptAt: 0,
    hold: "verify_effect",
  });
  expect(store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({
    paused: 1,
  });
  expect(store.runnable("research", Date.now())).toBe(false);
  const run = runRows(store)[0]!;
  expect(run).toMatchObject({ state: "failed", stopReason: "model_failure" });
  const status = c.operations.status("UOWNER") as any,
    agent = status.agents.find((entry: any) => entry.id === "research");
  expect(agent).toMatchObject({ paused: true, resumeHold: "verify_effect", nextAttemptAt: null });
  expect(agent.resumeAction).toContain("unresolved execution result");
});

it("adds no hold to an aborted attempt, so the next run of the channel resumes the delivery", async () => {
  const {
    store,
    collaboration: c,
    supervisor,
    work,
  } = setup(() => ({
    close() {},
    async run() {
      throw faultError(abortFault("the run was aborted before the worker finished"));
    },
  }));
  const delivery = c.enqueue("research", work, "aborted", {});
  expect(await supervisor.step("research")).toBe(true);
  // A shutdown or a stop the person already made must not become a hold: the delivery stays for
  // the next run instead of waiting for someone to release the channel.
  expect(store.resumeState("research")).toEqual({ attempt: 0, nextAttemptAt: 0, hold: null });
  expect(store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({
    paused: 0,
  });
  expect(store.delivery(delivery).status).toBe("injected");
  expect(store.runnable("research", Date.now())).toBe(true);
});

it("a person's stop that lands while the attempt runs outranks the scheduled retry", async () => {
  const {
    store,
    collaboration: c,
    supervisor,
    work,
  } = setup(() => ({
    close() {},
    async run() {
      // The person's stop arrives while this attempt is still running, and the attempt then fails
      // with the transient fault that would otherwise have scheduled a retry.
      store.pause("research");
      throw transient();
    },
  }));
  const delivery = c.enqueue("research", work, "stop-race", {});
  expect(await supervisor.step("research")).toBe(true);
  expect(store.resumeState("research")).toEqual({ attempt: 0, nextAttemptAt: 0, hold: null });
  expect(store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({
    paused: 1,
  });
  expect(store.delivery(delivery).status).toBe("injected");
  expect(runRows(store)[0]).toMatchObject({ state: "interrupted", stopReason: "owner_pause" });
  // Nothing retries until the person resumes the Agent.
  expect(await supervisor.step("research")).toBe(false);
  store.resume("research");
  expect(store.runnable("research", Date.now())).toBe(true);
  expect(await supervisor.step("research")).toBe(true);
}, 20000);

it("retries without repeating a confirmed effect and without treating an unknown effect as unexecuted", async () => {
  let now = 3_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const target = fixtureTarget("CTEST", "100.000001");
  let attempt = 0,
    firstReply: unknown,
    secondReply: unknown,
    retrySpec: import("../../src/runtime/engine.js").RunSpec | undefined;
  const {
    store,
    collaboration: c,
    supervisor,
    work,
  } = setup(() => ({
    close() {},
    async run(spec, hooks) {
      retrySpec = spec;
      const call = () => hooks.tool("create-once", "tasks.create", { target, title: "keep me" });
      if (attempt++ === 0) {
        // The engine journals the model's tool call before executing it; the attempt then dies
        // before the matching result is journaled, which is the window the retry has to repair.
        await hooks.journal(
          answer(
            [
              {
                type: "toolCall",
                id: "create-once",
                name: "mate",
                arguments: { operation: "tasks.create", args: { target, title: "keep me" } },
              },
            ],
            "toolUse",
          ),
        );
        firstReply = (await call()).value;
        // An operation that started and never recorded a result is exactly the case the next
        // attempt must not treat as never having run.
        store.prepareAction(activeRun(store), "in-flight", {
          operation: { kind: "exec", command: "synthetic" },
        });
        store.startAction(activeRun(store), "in-flight");
        throw transient();
      }
      secondReply = (await call()).value;
      return { tokens: 1, cost: 0, certain: true, waiting: false, continuation: false };
    },
  }));
  c.enqueue("research", work, "effects", {});
  expect(await supervisor.step("research")).toBe(true);
  expect(c.list("research")).toHaveLength(1);
  expect(store.action("in-flight")?.state).toBe("unknown");
  now += 1000;
  expect(await supervisor.step("research")).toBe(true);
  // Re-issuing the identical confirmed call replays its receipt instead of creating a second task.
  expect(secondReply).toEqual(firstReply);
  expect(c.list("research")).toHaveLength(1);
  expect(store.action("in-flight")?.state).toBe("unknown");
  // The retry is told what already happened: a confirmed receipt and an operation of unknown state.
  expect(JSON.stringify(retrySpec!.messages)).toContain("recoveredAction");
  expect(JSON.stringify(retrySpec!.messages)).toContain("Historical receipt");
  expect(JSON.parse(retrySpec!.recovery).uncertainActions).toEqual([
    { id: "in-flight", state: "unknown" },
  ]);
});

it("holds and pauses the Agent for a failure the runtime must not retry by itself", async () => {
  const {
    store,
    collaboration: c,
    supervisor,
    work,
  } = setup(() => ({
    close() {},
    async run() {
      // The durable record itself failed, so its usage and unfinished effects are uncertain: the
      // runtime must not try this delivery again on its own.
      throw faultError(fault("persistence", "shared_persistence", "durable record write failed"));
    },
  }));
  const delivery = c.enqueue("research", work, "unclassified", {});
  expect(await supervisor.step("research")).toBe(true);
  expect(store.resumeState("research")).toEqual({
    attempt: 0,
    nextAttemptAt: 0,
    hold: "no_retry",
  });
  // A hold is a stop for a person, so the Agent is paused: owner status and deployment health
  // report it as needing attention instead of as running.
  expect(store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({
    paused: 1,
  });
  expect(store.runnable("research", Date.now())).toBe(false);
  expect(store.delivery(delivery).status).toBe("injected");
  for (let attempt = 0; attempt < 5; attempt++)
    expect(await supervisor.step("research")).toBe(false);
  const status = c.operations.status("UOWNER") as any,
    agent = status.agents.find((entry: any) => entry.id === "research");
  expect(agent).toMatchObject({ paused: true, resumeHold: "no_retry", nextAttemptAt: null });
  expect(agent.resumeAction).toContain("agent-resume");
});

it("keeps the interval it had reached when a stop ends the attempt instead of a failure", async () => {
  let now = 4_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let attempt = 0;
  const {
    store,
    collaboration: c,
    supervisor,
    work,
  } = setup(() => ({
    close() {},
    async run() {
      const current = ++attempt;
      if (current === 1 || current === 3) throw transient();
      // The second attempt ends as an abort — a shutdown, not a provider failure.
      throw faultError(abortFault("the run was aborted before the worker finished"));
    },
  }));
  c.enqueue("research", work, "streak", {});
  expect(await supervisor.step("research")).toBe(true);
  expect(store.resumeState("research")).toMatchObject({ attempt: 1, hold: "retry_backoff" });
  now += 1000;
  expect(await supervisor.step("research")).toBe(true);
  // An abort adds no hold, and it does not erase the failures this Agent already waited out: a
  // restart after it, or the next transient failure, waits the interval it had reached.
  expect(store.resumeState("research")).toEqual({ attempt: 1, nextAttemptAt: 0, hold: null });
  expect(store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({
    paused: 0,
  });
  expect(store.runnable("research", now)).toBe(true);
  expect(await supervisor.step("research")).toBe(true);
  expect(store.resumeState("research")).toEqual({
    attempt: 2,
    nextAttemptAt: now + 2000,
    hold: "retry_backoff",
  });
});

it("does not hold an Agent whose run was stopped by this process shutting down", async () => {
  const gate = deferred();
  let entered!: () => void;
  const preparing = new Promise<void>((resolve) => (entered = resolve));
  const {
    store,
    collaboration: c,
    supervisor,
    work,
  } = setup(
    () => ({
      close() {},
      async run() {
        throw new Error("a worker must not be created after shutdown");
      },
    }),
    async () => {
      entered();
      await gate.promise;
      return "";
    },
  );
  const delivery = c.enqueue("research", work, "shutdown", {});
  const stepping = supervisor.step("research");
  // Shutdown arrives while the run is preparing, before any worker process exists.
  await preparing;
  supervisor.stopAdvancing();
  gate.resolve();
  expect(await stepping).toBe(true);
  // The stop is what governs this channel, so the attempt is an abort with no hold and no pause:
  // the pending delivery waits for the next run of the same channel after a restart.
  expect(store.resumeState("research")).toEqual({ attempt: 0, nextAttemptAt: 0, hold: null });
  expect(store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({
    paused: 0,
  });
  expect(store.delivery(delivery).status).toBe("injected");
}, 20000);
