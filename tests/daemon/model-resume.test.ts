import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Daemon } from "../../src/daemon/app.js";
import { daemonConfigSchema } from "../../src/daemon/config.js";
import { PendingControl, type Controls } from "../../src/daemon/control.js";
import { faultError, type FaultCategory, type FaultStage } from "../../src/runtime/fault.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

const fault = (stage: FaultStage, category: FaultCategory, reason: string) =>
  faultError({ stage, category, reason });
/** Exactly what a real worker process reports for a provider connection that failed transiently. */
const transient = () => fault("model", "transient_model", "provider connection reset");
/** Bounded waiting for a condition the daemon's own 500ms scheduling loop has to reach. */
const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The deployment's own local entry with one run slot: two Agents, one shared internal room and a
 * scripted model. Only the clock is controlled, because the local entry batches a new message into
 * a short notice window before it becomes an Agent's input.
 */
function deployment() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-model-resume-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const raw = JSON.parse(readFileSync(resolve("mate.local.example.json"), "utf8"));
  raw.runtime.dataDir = join(root, "data");
  raw.runtime.limits = { maxActiveRuns: 1, maxBackendOperations: 1, workerIdleMs: 300000 };
  const previous = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY = "synthetic";
  cleanups.push(() => {
    if (previous === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = previous;
  });
  return raw;
}
/** One running process on that deployment; a restart is this called again on the same data. */
async function processOf(raw: unknown): Promise<Daemon> {
  const instance = await Daemon.create(daemonConfigSchema.parse(raw), {
    info: () => {},
    error: () => {},
  });
  cleanups.push(() => instance.close());
  vi.spyOn(instance.supervisor, "recovery").mockResolvedValue("synthetic private recovery");
  return instance;
}
async function harness() {
  const clock = { now: 1_000_000 };
  vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  const raw = deployment(),
    instance = await processOf(raw);
  /** Bring this input into its due window, so scheduling is controlled rather than slept through. */
  const makeDue = () => {
    for (const row of instance.store.db.prepare("SELECT payload FROM deliveries").all() as {
      payload: string;
    }[])
      clock.now = Math.max(
        clock.now,
        (JSON.parse(row.payload) as { notBefore?: number }).notBefore ?? 0,
      );
  };
  return { raw, instance, clock, makeDue };
}
/** One scripted model per Agent: the script decides what the first and every later attempt does. */
function script(
  instance: Daemon,
  run: (
    agentId: string,
    attempt: number,
  ) =>
    | Promise<{
        tokens: number;
        cost: number;
        certain: boolean;
        waiting: boolean;
        continuation: boolean;
      }>
    | never,
) {
  const attempts = new Map<string, number>(),
    started: string[] = [];
  vi.spyOn(instance.supervisor, "factory").mockImplementation((agent) => ({
    close() {},
    async run() {
      started.push(agent.id);
      const attempt = (attempts.get(agent.id) ?? 0) + 1;
      attempts.set(agent.id, attempt);
      return run(agent.id, attempt);
    },
  }));
  return started;
}
function delivery(instance: Daemon, agentId: string) {
  return instance.store.db
    .prepare(
      "SELECT id,status FROM deliveries WHERE agent_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
    )
    .get(agentId) as { id: string; status: string };
}
function runs(instance: Daemon, agentId: string) {
  return instance.store.db
    .prepare("SELECT created_at,state,stop_reason FROM runs WHERE agent_id=? ORDER BY rowid")
    .all(agentId) as { created_at: number; state: string; stop_reason: string | null }[];
}
async function ownerControl(controls: Controls, text: string): Promise<any> {
  const outcome = controls.execute("owner", text);
  return outcome instanceof PendingControl ? await outcome.result : outcome;
}

it("keeps another Agent and the control entry responsive while one Agent waits for its retry", async () => {
  const { instance, clock, makeDue } = await harness();
  const started = script(instance, async (agentId, attempt) => {
    if (agentId === "research" && attempt === 1) throw transient();
    return { tokens: 1, cost: 0, certain: true, waiting: false, continuation: false };
  });
  instance.local!.receive(
    "owner",
    "carry-this",
    { conversationId: "team-room" },
    "carry this work",
  );
  makeDue();
  await instance.start();
  // The first attempt failed transiently: this Agent waits instead of being paused.
  await vi.waitFor(() =>
    expect(instance.store.resumeState("research")).toMatchObject({
      attempt: 1,
      hold: "retry_backoff",
    }),
  );
  const scheduled = instance.store.resumeState("research").nextAttemptAt;
  expect(scheduled).toBe(clock.now + 1000);
  expect(instance.store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({
    paused: 0,
  });
  // While it waits, the peer's own delivery and an owner control request both complete. The single
  // run slot is free, so this Agent's wait is not what the peer was waiting for.
  await vi.waitFor(() => expect(delivery(instance, "writer").status).toBe("handled"));
  const status = await ownerControl(instance.controls, "status");
  expect(started).toEqual(["research", "writer"]);
  expect(status.agents.find((agent: any) => agent.id === "research")).toMatchObject({
    paused: false,
    resumeHold: "retry_backoff",
    nextAttemptAt: scheduled,
    resumeAction: null,
  });
  expect(status.agents.find((agent: any) => agent.id === "writer")).toMatchObject({
    paused: false,
    resumeHold: null,
    nextAttemptAt: null,
    resumeAction: null,
  });
  // Time passing is not enough: the stored attempt time is what releases it, with no human action.
  await settle(1200);
  expect(started).toEqual(["research", "writer"]);
  clock.now = scheduled;
  await vi.waitFor(() => expect(delivery(instance, "research").status).toBe("handled"), {
    timeout: 3000,
  });
  expect(started).toEqual(["research", "writer", "research"]);
  const attempts = runs(instance, "research");
  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.created_at).toBeGreaterThanOrEqual(scheduled);
  expect(instance.store.resumeState("research")).toEqual({
    attempt: 0,
    nextAttemptAt: 0,
    hold: null,
  });
}, 20000);

it("keeps the pending work and the stored attempt time across a daemon restart", async () => {
  const { raw, instance, clock, makeDue } = await harness();
  script(instance, async (agentId, attempt) => {
    if (agentId === "research" && attempt === 1) throw transient();
    return { tokens: 1, cost: 0, certain: true, waiting: false, continuation: false };
  });
  instance.local!.receive(
    "owner",
    "restart-me",
    { conversationId: "team-room" },
    "restart this work",
  );
  makeDue();
  await instance.start();
  await vi.waitFor(() =>
    expect(instance.store.resumeState("research")).toMatchObject({ hold: "retry_backoff" }),
  );
  const scheduled = instance.store.resumeState("research").nextAttemptAt,
    retained = delivery(instance, "research");
  await instance.close();

  // A fresh process on the same data directory reads the stored attempt time, so booting is not a
  // reason to try the same failed call again.
  const restarted = await processOf(raw);
  const restartedStarted = script(restarted, async () => ({
    tokens: 1,
    cost: 0,
    certain: true,
    waiting: false,
    continuation: false,
  }));
  await restarted.start();
  await settle(1200);
  expect(restartedStarted).toEqual([]);
  expect(restarted.store.resumeState("research")).toEqual({
    attempt: 1,
    nextAttemptAt: scheduled,
    hold: "retry_backoff",
  });
  expect(delivery(restarted, "research")).toEqual(retained);
  // The work itself survived: the human's message and the delivery's injected input are both there.
  expect(
    restarted.local!.read("owner", { conversationId: "team-room" }).messages.map((m) => m.text),
  ).toContain("restart this work");
  const session = (
    restarted.store.db.prepare("SELECT session_id FROM agents WHERE id='research'").get() as {
      session_id: string;
    }
  ).session_id;
  expect(
    (
      restarted.store.db.prepare("SELECT key FROM entries WHERE session_id=?").all(session) as {
        key: string;
      }[]
    ).map((row) => row.key),
  ).toContain(`delivery:${retained.id}`);

  // The stored instant is what releases the attempt, and the retry then finishes the delivery.
  clock.now = scheduled;
  await vi.waitFor(() => expect(delivery(restarted, "research").status).toBe("handled"), {
    timeout: 3000,
  });
  expect(restartedStarted).toEqual(["research"]);
  const attempts = runs(restarted, "research");
  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.created_at).toBeGreaterThanOrEqual(scheduled);
}, 20000);

it("makes a person's stop outrank the scheduled attempt and an explicit resume release it", async () => {
  const { instance, clock, makeDue } = await harness();
  const started = script(instance, async (agentId, attempt) => {
    if (agentId === "research" && attempt === 1) throw transient();
    return { tokens: 1, cost: 0, certain: true, waiting: false, continuation: false };
  });
  instance.local!.receive("owner", "stop-me", { conversationId: "team-room" }, "stop this work");
  makeDue();
  await instance.start();
  await vi.waitFor(() =>
    expect(instance.store.resumeState("research")).toMatchObject({ hold: "retry_backoff" }),
  );
  const scheduled = instance.store.resumeState("research").nextAttemptAt;
  await ownerControl(instance.controls, "agent-stop research");
  // The stop cancels the automatic attempt; the Agent's pending work is retained, not discarded.
  expect(instance.store.resumeState("research")).toEqual({
    attempt: 0,
    nextAttemptAt: 0,
    hold: null,
  });
  expect(delivery(instance, "research").status).toBe("injected");
  clock.now = scheduled + 60_000;
  await settle(1200);
  expect(started.filter((agentId) => agentId === "research")).toHaveLength(1);
  expect(delivery(instance, "research").status).toBe("injected");
  // Only the person's own resume continues the Agent, and it does so without waiting again.
  await ownerControl(instance.controls, "agent-resume research");
  await vi.waitFor(() => expect(delivery(instance, "research").status).toBe("handled"));
  expect(started.filter((agentId) => agentId === "research")).toHaveLength(2);
}, 20000);

it("lets a person cancelling the work item outrank the attempt it had scheduled", async () => {
  const { instance, clock, makeDue } = await harness();
  const started = script(instance, async (agentId, attempt) => {
    if (agentId === "research" && attempt === 1) throw transient();
    return { tokens: 1, cost: 0, certain: true, waiting: false, continuation: false };
  });
  instance.local!.receive(
    "owner",
    "cancel-me",
    { conversationId: "team-room" },
    "cancel this work",
  );
  makeDue();
  await instance.start();
  await vi.waitFor(() =>
    expect(instance.store.resumeState("research")).toMatchObject({ hold: "retry_backoff" }),
  );
  const scheduled = instance.store.resumeState("research").nextAttemptAt,
    deliveryId = delivery(instance, "research").id,
    workId = (
      instance.store.db
        .prepare("SELECT work_id FROM delivery_work WHERE delivery_id=?")
        .get(deliveryId) as { work_id: string }
    ).work_id;
  await ownerControl(instance.controls, `cancel ${workId}`);
  // The cancelled work drops the schedule instead of leaving an attempt that can never run, and no
  // automatic attempt happens once the stored instant has passed.
  expect(instance.store.resumeState("research")).toEqual({
    attempt: 0,
    nextAttemptAt: 0,
    hold: null,
  });
  const status = await ownerControl(instance.controls, "status");
  expect(status.agents.find((agent: any) => agent.id === "research")).toMatchObject({
    resumeHold: null,
    nextAttemptAt: null,
    resumeAction: null,
  });
  clock.now = scheduled + 60_000;
  await settle(1200);
  expect(started.filter((agentId) => agentId === "research")).toHaveLength(1);
  expect(instance.store.db.prepare("SELECT state FROM works WHERE id=?").get(workId)).toEqual({
    state: "cancelled",
  });
}, 20000);

it("holds only the Agent whose credential failed and reports the action a person must take", async () => {
  const { instance, clock, makeDue } = await harness();
  const started = script(instance, async (agentId, attempt) => {
    if (agentId === "research" && attempt === 1)
      throw fault("model", "credential_config", "invalid api key provided");
    return { tokens: 1, cost: 0, certain: true, waiting: false, continuation: false };
  });
  instance.local!.receive("owner", "credential", { conversationId: "team-room" }, "carry this");
  makeDue();
  await instance.start();
  await vi.waitFor(() =>
    expect(instance.store.resumeState("research")).toMatchObject({ hold: "human_action" }),
  );
  // Only the affected Agent is held, with no automatic attempt scheduled and its run reason kept.
  expect(instance.store.resumeState("research")).toEqual({
    attempt: 0,
    nextAttemptAt: 0,
    hold: "human_action",
  });
  expect(runs(instance, "research")[0]).toMatchObject({
    state: "failed",
    stop_reason: "model_failure",
  });
  expect(instance.store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({
    paused: 1,
  });
  expect(delivery(instance, "research").status).toBe("injected");
  // The peer Agent is untouched and finishes its own delivery.
  await vi.waitFor(() => expect(delivery(instance, "writer").status).toBe("handled"));
  const status = await ownerControl(instance.controls, "status");
  const affected = status.agents.find((agent: any) => agent.id === "research");
  expect(affected).toMatchObject({ paused: true, resumeHold: "human_action", nextAttemptAt: null });
  expect(affected.resumeAction).toContain("credential");
  expect(status.agents.find((agent: any) => agent.id === "writer")).toMatchObject({
    paused: false,
    resumeHold: null,
    resumeAction: null,
  });
  // A held Agent never retries by itself; the person's resume is what continues it.
  clock.now += 60_000;
  await settle(1200);
  expect(started.filter((agentId) => agentId === "research")).toHaveLength(1);
  await ownerControl(instance.controls, "agent-resume research");
  await vi.waitFor(() => expect(delivery(instance, "research").status).toBe("handled"));
}, 20000);
