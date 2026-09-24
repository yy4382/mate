import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Store } from "../../src/storage/store.js";
import { configSchema } from "../../src/config.js";
import { configFixture } from "../helpers/config.js";
import { Messages, Output, anchoredTask, fixtureTarget } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { CanonicalAttention } from "../../src/conversations/attention.js";
import { CanonicalFreshnessGate } from "../../src/conversations/freshness.js";
import { Broker } from "../../src/policy/broker.js";
import { Supervisor, type Worker } from "../../src/runtime/supervisor.js";
import { ToolRouter } from "../../src/runtime/tools.js";
import { UsageLedger } from "../../src/usage/ledger.js";
import { diagnosticLogs } from "../../src/operations/diagnostics.js";

/**
 * The run module owns the recovery input a resumption is built from; the scheduler owns run
 * lifetime. These tests drive the real scheduler, store, task module and tool router with a
 * scripted model, so they assert what an Agent can observe instead of internal call order.
 */
const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
const target = fixtureTarget("CTEST", "100.000001");

function temporary() {
  const root = mkdtempSync(join(tmpdir(), "mate-run-recovery-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function setup(options: { path?: string; failWrites?: () => boolean } = {}) {
  const config = configSchema.parse({
    ...configFixture,
    agents: [
      configFixture.agents[0],
      {
        ...configFixture.agents[0],
        id: "peer",
        name: "Peer",
        slackAppId: "ATWO",
        slackUserId: "UTWO",
        slackBotId: "BTWO",
        botTokenEnv: "PEER_BOT",
        appTokenEnv: "PEER_APP",
      },
    ],
  });
  const store = new Store(options.path ?? ":memory:"),
    messages = new Messages(store, config),
    attention = new CanonicalAttention(messages),
    output = new Output(
      messages,
      { post: async () => ({ ts: "100.000002" }) },
      Date.now,
      new CanonicalFreshnessGate(messages, attention),
    ),
    collaboration = new Collaboration(store, messages, output, config, attention),
    broker = new Broker(
      store,
      collaboration,
      {
        execute: async (request) => {
          if ((request.operation as { kind: string }).kind === "write" && options.failWrites?.())
            throw Object.assign(new Error("remote write connection reset"), { code: "ECONNRESET" });
          return { code: 0, stdout: "ok", stderr: "", truncated: false };
        },
      },
      { research: "/tmp", peer: "/tmp" },
    ),
    router = new ToolRouter(collaboration, broker);
  cleanups.push(() => store.close());
  const work = collaboration.createWork("human:one", target);
  return { config, store, messages, collaboration, broker, router, work };
}

/** Build a scheduler whose worker is the test's own scripted model, never a real provider. */
function scheduled(
  f: ReturnType<typeof setup>,
  model: (run: number, spec: { recovery: string; messages: unknown[] }, hooks: any) => Promise<any>,
  memory: () => string = () => "synthetic memory",
) {
  let run = 0;
  const supervisor = new Supervisor(
    f.collaboration,
    f.router,
    f.config,
    () =>
      ({
        close() {},
        run: async (spec: { recovery: string; messages: unknown[] }, hooks: any) =>
          model(++run, spec, hooks) as Promise<never>,
      }) as unknown as Worker,
    async () => memory(),
  );
  supervisor.register();
  return supervisor;
}

function runRow(store: Store, agent = "research") {
  return store.db
    .prepare(
      "SELECT id,state,stop_reason stopReason FROM runs WHERE agent_id=? ORDER BY rowid DESC",
    )
    .get(agent) as { id: string; state: string; stopReason: string | null } | undefined;
}

it("the run module gathers checkpoint, work, tasks, usage and unknown operations into the recovery input", async () => {
  const f = setup();
  let recovery = "";
  const supervisor = scheduled(f, async (_run, spec) => {
    recovery = spec.recovery;
    return { tokens: 0, cost: 0, certain: true, waiting: false, continuation: false };
  });
  for (const agent of ["research", "peer"]) f.messages.membership(agent, "CTEST", true);
  const task = anchoredTask(f.collaboration, "research", f.work, target, "durable task");
  f.collaboration.claim("research", task);
  // The Agent's own checkpoint, a recorded model call and an unresolved execution all have to be
  // visible to the resumption, and each is durable state the scheduler does not read itself.
  // The unresolved execution is left by an earlier run of this same Agent that failed.
  f.collaboration.enqueue("research", f.work, "seed", { text: "seed" });
  const run = f.store.beginRun("research")!;
  f.collaboration.bindRunWork(run, f.work);
  f.store.input(run, { role: "user", content: "synthetic input" });
  f.router.sessions.checkpoint("research", "resume from the checkpoint");
  new UsageLedger(f.store).begin(run, f.work, 1, "openai", "synthetic");
  f.store.prepareAction(run, "UNRESOLVED", { command: "synthetic-command" });
  f.store.startAction(run, "UNRESOLVED");
  f.store.finish(run, "worker crashed", "model_failure");
  f.store.resume("research");
  f.collaboration.enqueue("research", f.work, "recovery-input", { text: "input" });
  expect(await supervisor.step("research")).toBe(true);
  const parsed = JSON.parse(recovery);
  expect(parsed.memory).toBe("synthetic memory");
  expect(parsed.memoryHash).toMatch(/^[0-9a-f]{64}$/);
  expect(parsed.work).toMatchObject({ id: f.work, state: "active" });
  expect(parsed.checkpoint).toMatchObject({ text: "resume from the checkpoint", version: 1 });
  expect(parsed.tasks.categories.owned.items).toEqual([
    expect.objectContaining({ id: task, status: "doing", owner: "research" }),
  ]);
  expect(parsed.usage).toMatchObject({ knownCalls: 0, unknownCalls: 1 });
  expect(parsed.uncertainActions).toEqual([{ id: "UNRESOLVED", state: "unknown" }]);
  expect(parsed.actionHistoryTool).toBe("actions.list");
  supervisor.close();
});

it("a normal yield stays resumable and is distinguishable from a model fault and a human pause", async () => {
  const f = setup();
  let run = 0,
    resumedInput = "";
  const supervisor = scheduled(f, async (attempt, spec) => {
    run++;
    if (attempt > 1) resumedInput = JSON.stringify(spec.messages);
    return {
      tokens: 0,
      cost: 0,
      certain: true,
      waiting: false,
      // The first run stops at its own turn budget with the delivery still unfinished: a yield.
      continuation: attempt === 1,
    };
  });
  f.messages.membership("research", "CTEST", true);
  const delivery = f.collaboration.enqueue("research", f.work, "yield", { text: "unfinished" });
  expect(await supervisor.step("research")).toBe(true);
  const yielded = runRow(f.store)!;
  expect(yielded.state).not.toBe("failed");
  expect(yielded.state).not.toBe("interrupted");
  // A run that stops on its own turn budget is recorded as a turn-budget yield, which is a
  // different condition from a run that released its slot to wait for an external result.
  expect(yielded.stopReason).toBe("turn_budget");
  // The unfinished delivery stays durable instead of being reported as handled.
  expect(f.store.delivery(delivery).status).toBe("injected");
  expect(f.store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({
    paused: 0,
  });
  // The resumed run continues the same delivery, and no duplicate continuation is queued for it.
  expect(await supervisor.step("research")).toBe(true);
  // The resumption knows it is continuing a yield, not an interrupted delivery, so it says so.
  expect(resumedInput).toContain("Continue the same durable inbox delivery");
  expect(resumedInput).not.toContain("Resume the interrupted inbox delivery");
  expect(f.store.delivery(delivery).status).toBe("handled");
  expect(f.store.db.prepare("SELECT count(*) n FROM deliveries").get()).toEqual({ n: 1 });
  expect(run).toBe(2);
  expect(await supervisor.step("research")).toBe(false);
  supervisor.close();

  // A model fault keeps the input but pauses the Agent, so it retries only after an explicit
  // resume: a different condition from the yield above, which resumes by itself.
  const faulty = setup();
  const failing = scheduled(faulty, async () => {
    throw new Error("model unavailable");
  });
  faulty.messages.membership("research", "CTEST", true);
  const input = faulty.collaboration.enqueue("research", faulty.work, "fail", {});
  await failing.step("research");
  expect(runRow(faulty.store)).toMatchObject({ state: "failed", stopReason: "model_failure" });
  expect(faulty.store.delivery(input).status).toBe("injected");
  expect(faulty.store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({
    paused: 1,
  });
  // The failed delivery is not retried on its own, however often the scheduler polls.
  for (let attempt = 0; attempt < 5; attempt++) expect(await failing.step("research")).toBe(false);
  expect(faulty.store.db.prepare("SELECT count(*) n FROM runs").get()).toEqual({ n: 1 });
  failing.close();
});

it("a failed run does not retry its own delivery in a hot loop", async () => {
  const f = setup();
  const supervisor = scheduled(f, async () => {
    // A failure the durable record itself produced: it will fail identically every time until a
    // human acts, so the scheduler must not pick the same delivery up again by itself.
    throw Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" });
  });
  f.messages.membership("research", "CTEST", true);
  const delivery = f.collaboration.enqueue("research", f.work, "hot-loop", {});
  expect(await supervisor.step("research")).toBe(true);
  expect(f.store.delivery(delivery).status).toBe("injected");
  for (let attempt = 0; attempt < 20; attempt++)
    expect(await supervisor.step("research")).toBe(false);
  // One attempt, one run row and one owner fact: no backoff policy exists yet, so the pause is
  // what keeps a deterministically failing delivery from spinning.
  expect(f.store.db.prepare("SELECT count(*) n FROM runs").get()).toEqual({ n: 1 });
  expect(
    f.store.db.prepare("SELECT count(*) n FROM operational_facts WHERE kind='run_failed'").get(),
  ).toEqual({ n: 1 });
  // The input is still there for the explicit resume that releases it.
  f.store.resume("research");
  expect(await supervisor.step("research")).toBe(true);
  expect(f.store.db.prepare("SELECT count(*) n FROM runs").get()).toEqual({ n: 2 });
  supervisor.close();
});

it("keeps a shared-persistence failure distinguishable while still refusing a self-retry", async () => {
  const f = setup();
  const supervisor = scheduled(f, async () => {
    throw Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" });
  });
  f.messages.membership("research", "CTEST", true);
  f.collaboration.enqueue("research", f.work, "persistence", {});
  await supervisor.step("research");
  // The run failed and its shared fault is recorded, so the caller can tell the categories apart.
  expect(runRow(f.store)?.state).toBe("failed");
  const fault = JSON.parse(
    (
      f.store.db.prepare("SELECT body FROM audit WHERE kind='run_failure'").get() as {
        body: string;
      }
    ).body,
  ).fault;
  expect(fault).toMatchObject({ stage: "persistence", category: "shared_persistence" });
  // A failure the record itself produced is still a failure: it waits for the resume that owns
  // the decision, instead of spinning against a store that cannot record the outcome.
  expect(f.store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({
    paused: 1,
  });
  supervisor.close();
});

it("resumes an interrupted delivery after restart without repeating unknown side effects", async () => {
  const path = join(temporary(), "state.sqlite");
  const first = setup({ path, failWrites: () => true });
  const supervisor = scheduled(first, async (_run, _spec, hooks: any) => {
    // An external effect starts and is never confirmed: the write crosses the boundary and fails.
    await hooks.tool("write", "file.write", { path: "notes.txt", content: "synthetic" });
    throw new Error("worker crashed mid-run");
  });
  first.messages.membership("research", "CTEST", true);
  const delivery = first.collaboration.enqueue("research", first.work, "restart", {
    text: "finish me",
  });
  await expect(supervisor.step("research")).resolves.toBe(true);
  expect(first.store.delivery(delivery).status).toBe("injected");
  expect(runRow(first.store)?.state).toBe("failed");
  const session = (
    first.store.db.prepare("SELECT session_id FROM agents WHERE id='research'").get() as {
      session_id: string;
    }
  ).session_id;
  const effect = first.store.action(`${session}:write`);
  expect(effect?.state).toBe("unknown");
  supervisor.close();
  first.store.close();

  const reopened = setup({ path, failWrites: () => true });
  reopened.store.recover();
  reopened.messages.membership("research", "CTEST", true);
  let resumed = "";
  const second = scheduled(reopened, async (_run, spec, hooks: any) => {
    resumed = spec.recovery;
    // The resumption verifies the unresolved effect instead of running it again.
    const listed = await hooks.tool("list", "actions.list", {});
    return {
      tokens: 0,
      cost: 0,
      certain: true,
      waiting: false,
      continuation: false,
      listed,
    };
  });
  // The unconfirmed effect paused the Agent, so the resumption needs the same explicit resume a
  // human fault does; that is a different condition from a yield, which resumes on its own.
  expect(await second.step("research")).toBe(false);
  reopened.store.resume("research");
  expect(await second.step("research")).toBe(true);
  expect(reopened.store.delivery(delivery).status).toBe("handled");
  expect(runRow(reopened.store)?.state).toBe("complete");
  // The recovery package still names the unresolved execution, and the second attempt never
  // repeated the write that may already have happened.
  expect(JSON.parse(resumed).uncertainActions).toEqual([{ id: effect!.id, state: "unknown" }]);
  expect(reopened.store.action(effect!.id)?.state).toBe("unknown");
  second.close();
});

it("keeps one main run channel per agent while one run spans several authorized work items", async () => {
  const f = setup();
  let concurrent = 0,
    most = 0,
    reachable = "";
  const other = f.collaboration.createWork("human:two", fixtureTarget("CTWO", "100.000001"));
  const supervisor = scheduled(f, async (_run, _spec, hooks: any) => {
    concurrent++;
    most = Math.max(most, concurrent);
    // The run continues on a second authorized work item without ending, then still reads a file
    // it was working with before the switch. Work identity is not a file or execution boundary.
    await hooks.tool("switch", "works.select", { workId: other });
    reachable = (await hooks.tool("read", "file.read", { path: "notes.txt" }))
      .value as unknown as string;
    concurrent--;
    return { tokens: 0, cost: 0, certain: true, waiting: false, continuation: false };
  });
  for (const agent of ["research", "peer"]) {
    f.messages.membership(agent, "CTEST", true);
    f.messages.membership(agent, "CTWO", true);
  }
  const delivery = f.collaboration.enqueue("research", f.work, "one", {});
  await supervisor.step("research");
  expect(most).toBe(1);
  // The read reached the backend while the run was attributed to a different work item, so work
  // ownership granted and withheld nothing: the action is recorded against the run itself.
  const selected = f.store.db
    .prepare("SELECT work_id FROM run_context WHERE run_id=?")
    .get(runRow(f.store)!.id) as { work_id: string };
  expect(selected.work_id).toBe(other);
  expect(
    f.store.db.prepare("SELECT count(*) n FROM actions WHERE agent_id='research'").get(),
  ).toEqual({ n: 2 });
  expect(f.store.delivery(delivery).status).toBe("handled");
  // One run served the delivery and then moved its selection, all on one channel.
  const run = runRow(f.store)!;
  expect(run.state).toBe("complete");
  expect(f.store.db.prepare("SELECT work_id FROM run_context WHERE run_id=?").get(run.id)).toEqual({
    work_id: other,
  });
  expect(f.store.db.prepare("SELECT count(*) n FROM runs").get()).toEqual({ n: 1 });
  expect(f.store.db.prepare("SELECT count(*) n FROM runs WHERE state='active'").get()).toEqual({
    n: 0,
  });
  expect(reachable).toBeDefined();
  supervisor.close();
});

it("a scripted model can collaborate with a peer, yield, and continue on the same run channel", async () => {
  const f = setup();
  const observed: string[] = [];
  const supervisor = scheduled(f, async (run, _spec, hooks: any) => {
    if (run === 1) {
      // Direct peer collaboration: one message to a configured teammate, offered as real work on
      // the peer's own channel, without routing through a lead or a task tree.
      const parent = anchoredTask(f.collaboration, "research", f.work, target, "shared work");
      f.collaboration.claim("research", parent);
      f.collaboration.delegate("research", parent, "peer", "peer slice");
      observed.push("collaborated");
      // A context replacement yields the execution slot with the work still unfinished.
      await hooks.tool("reset", "sessions.reset", { text: "continue the shared work" });
      return { tokens: 0, cost: 0, certain: true, waiting: true, continuation: false };
    }
    observed.push("continued");
    return { tokens: 0, cost: 0, certain: true, waiting: false, continuation: false };
  });
  for (const agent of ["research", "peer"]) f.messages.membership(agent, "CTEST", true);
  const delivery = f.collaboration.enqueue("research", f.work, "collaborate", {});
  expect(await supervisor.step("research")).toBe(true);
  // The peer received the delegated slice as its own durable task waiting for publication, and
  // this Agent's delivery is finished by the context replacement rather than left dangling.
  expect(
    f.store.db
      .prepare("SELECT assigned_to,status,parent_id FROM tasks WHERE assigned_to='peer'")
      .all(),
  ).toEqual([{ assigned_to: "peer", status: "draft", parent_id: expect.any(String) }]);
  expect(f.store.delivery(delivery).status).toBe("handled");
  const reset = f.store.db.prepare("SELECT state FROM session_resets").get() as { state: string };
  expect(reset.state).toBe("applied");
  // Releasing the slot for a context replacement is a wait for the work to come back, recorded
  // separately from a turn-budget yield so the two never read as the same condition.
  expect(runRow(f.store)).toMatchObject({ state: "yielded", stopReason: "external_wait" });
  // The continuation runs on the same single channel and keeps the logical session.
  expect(await supervisor.step("research")).toBe(true);
  expect(observed).toEqual(["collaborated", "continued"]);
  // The logical session was replaced exactly once and both runs used the Agent's single channel.
  expect(f.store.db.prepare("SELECT count(*) n FROM sessions").get()).toEqual({ n: 3 });
  expect(f.store.db.prepare("SELECT count(*) n FROM runs").get()).toEqual({ n: 2 });
  expect(f.store.db.prepare("SELECT count(*) n FROM sessions WHERE agent_id='peer'").get()).toEqual(
    { n: 1 },
  );
  supervisor.close();
});

it("a seated blind reviewer receives its brief and recovery without any peer conclusion", async () => {
  const f = setup();
  let recovery = "",
    input = "",
    delivered: { content: string; timestamp: number }[] = [];
  const supervisor = scheduled(f, async (_run, spec, hooks: any) => {
    recovery = spec.recovery;
    delivered = (spec.messages as { role: string; content: unknown; timestamp: number }[]).map(
      (message) => ({ content: String(message.content), timestamp: message.timestamp }),
    );
    input = JSON.stringify(spec.messages) + (await hooks.notice?.());
    return { tokens: 0, cost: 0, certain: true, waiting: false, continuation: false };
  });
  for (const agent of ["research", "peer"]) f.messages.membership(agent, "CTEST", true);
  // A peer message whose body must never reach the independent reviewer.
  f.messages.record(
    {
      id: target.threadId,
      conversationId: target.conversationId,
      rootId: target.threadId,
      order: "100000001",
      revision: "100000001",
      text: "WITHHELD_PEER_CONCLUSION",
      author: { kind: "agent", id: "peer" },
      origin: "participant",
      mentions: [],
      attachments: [],
      deleted: false,
    },
    ["research"],
  );
  f.collaboration.seats.activate(
    "UOWNER",
    "research",
    target,
    "Independently compute 2+2; submit your own result.",
    () => "/synthetic/clean-review-root",
  );
  f.collaboration.enqueue("research", f.work, "review", {
    text: "WITHHELD_PEER_CONCLUSION",
    source: { id: "UTWO" },
    target,
  });
  expect(await supervisor.step("research")).toBe(true);
  // The brief reaches the reviewer as its delivered input, and the package carries only its own
  // durable state. Neither ever names the peer's conclusion or the peer's identity.
  expect(input).toContain("Independently compute 2+2");
  expect(input).not.toContain("WITHHELD_PEER_CONCLUSION");
  expect(input).not.toContain("UTWO");
  // The brief reaches the seat on a neutral turn: no wall-clock value the reviewer could
  // correlate with anything outside its own brief.
  const brief = delivered.find((message) => message.content.includes("Independently compute"))!;
  expect(brief.timestamp).toBe(0);
  const package_ = JSON.parse(recovery);
  expect(package_.work).toMatchObject({ id: f.work, reviewSeat: true });
  expect(package_.tasks).toBeNull();
  // The seat's own restrictions still refuse the paths that would expose peer context, on a fresh
  // run of the same seated Agent.
  f.collaboration.enqueue("research", f.work, "second-review-input", { target });
  const run = f.store.beginRun("research", Date.now(), true)!;
  const signal = new AbortController().signal;
  for (const [operation, args] of [
    ["attention.read", { target }],
    ["inbox.list", {}],
    ["tasks.list", {}],
  ] as const)
    await expect(f.router.call(run, f.work, operation, operation, args, signal)).rejects.toThrow(
      "isolates",
    );
  supervisor.close();
});

it("records an owner pause and a stopped work item as their own conditions that never self-resume", () => {
  const f = setup();
  // Registering is what creates each Agent's row and logical session; no scheduler step runs here.
  const supervisor = scheduled(f, async () => ({
    tokens: 0,
    cost: 0,
    certain: true,
    waiting: false,
    continuation: false,
  }));
  f.messages.membership("research", "CTEST", true);
  // A human pause ends the run under its own reason and keeps the Agent stopped.
  f.collaboration.enqueue("research", f.work, "paused", {});
  const paused = f.store.beginRun("research")!;
  f.store.input(paused, { role: "user", content: "input" });
  f.store.pause("research");
  expect(runRow(f.store)).toMatchObject({ state: "interrupted", stopReason: "owner_pause" });
  expect(f.store.beginRun("research")).toBeUndefined();
  f.store.resume("research");
  const resumed = f.store.beginRun("research")!;
  expect(resumed).toBeDefined();
  f.store.input(resumed, { role: "user", content: "input" });
  f.store.finish(resumed);

  // Stopping the work item ends its run under the work reason, and the owner has to resume it.
  const other = f.collaboration.createWork("human:two", fixtureTarget("CTWO", "100.000001"));
  f.messages.membership("research", "CTWO", true);
  f.collaboration.enqueue("research", other, "stopped", {});
  const stopped = f.store.beginRun("research")!;
  f.store.input(stopped, { role: "user", content: "input" });
  expect(f.collaboration.control("UOWNER", other, "pause")).toEqual([stopped.id]);
  expect(runRow(f.store)).toMatchObject({ state: "interrupted", stopReason: "work_stopped" });
  expect(f.store.beginRun("research", Date.now(), true)).toBeUndefined();
  supervisor.close();
});

it("keeps a seated reviewer on a neutral turn timestamp when its own run resumes", async () => {
  const f = setup();
  const seen: { content: string; timestamp: number }[][] = [];
  const supervisor = scheduled(f, async (attempt, spec) => {
    seen.push(
      (spec.messages as { content: unknown; timestamp: number }[]).map((message) => ({
        content: String(message.content),
        timestamp: message.timestamp,
      })),
    );
    // The first run yields with the delivery unfinished, so the second one resumes it.
    return { tokens: 0, cost: 0, certain: true, waiting: false, continuation: attempt === 1 };
  });
  for (const agent of ["research", "peer"]) f.messages.membership(agent, "CTEST", true);
  f.collaboration.seats.activate(
    "UOWNER",
    "research",
    target,
    "Independently audit the invoice total.",
    () => "/synthetic/clean-review-root",
  );
  const delivery = f.collaboration.enqueue("research", f.work, "seat-yield", {
    text: "WITHHELD_PEER_CONCLUSION",
    target,
  });
  expect(await supervisor.step("research")).toBe(true);
  expect(f.store.delivery(delivery).status).toBe("injected");
  expect(await supervisor.step("research")).toBe(true);
  // Both the first brief and the resumed turn sit on the neutral timestamp the seat always uses,
  // so nothing in the reviewer's own record is derived from outside its brief.
  const brief = seen[0]!.find((message) => message.content.includes("Independently audit"))!;
  const resumed = seen[1]!.findLast((message) =>
    message.content.includes("Continue the same durable inbox delivery"),
  )!;
  expect(brief.timestamp).toBe(0);
  expect(resumed.timestamp).toBe(0);
  expect(JSON.stringify(seen)).not.toContain("WITHHELD_PEER_CONCLUSION");
  supervisor.close();
});

it("makes a normal yield visible in the owner-facing diagnostic log", async () => {
  const f = setup();
  let attempt = 0;
  const supervisor = scheduled(f, async () => ({
    tokens: 0,
    cost: 0,
    certain: true,
    waiting: false,
    continuation: ++attempt === 1,
  }));
  f.messages.membership("research", "CTEST", true);
  f.collaboration.enqueue("research", f.work, "visible-yield", {});
  expect(await supervisor.step("research")).toBe(true);
  // The owner's view reads the durable fact the yield wrote, through the same path the deployed
  // application uses, so a normal yield is visible rather than silently dropped.
  const page = f.collaboration.operations.activity("UOWNER", { sources: ["runtime"] });
  expect(page.items.map((item) => item.kind)).toContain("runtime.run_yielded");
  expect(diagnosticLogs(page.items).events).toContainEqual({
    at: expect.any(Number),
    event: "runtime.run_yielded",
  });
  supervisor.close();
});

it("never leaves a run stuck active when recording its outcome fails", async () => {
  const f = setup();
  const supervisor = scheduled(f, async () => ({
    tokens: 0,
    cost: 0,
    certain: true,
    waiting: false,
    continuation: false,
  }));
  f.messages.membership("research", "CTEST", true);
  const delivery = f.collaboration.enqueue("research", f.work, "snapshot-failure", {});
  // The durable write that finishes the run fails once. The run's transition and the snapshot
  // share one transaction, so the failure must leave the channel usable rather than wedged.
  const snapshot = f.store.snapshot.bind(f.store);
  let calls = 0;
  f.store.snapshot = ((...args: Parameters<typeof snapshot>) => {
    if (++calls === 1) throw new Error("synthetic snapshot failure");
    return snapshot(...args);
  }) as typeof f.store.snapshot;
  expect(await supervisor.step("research")).toBe(true);
  expect(f.store.db.prepare("SELECT count(*) n FROM runs WHERE state='active'").get()).toEqual({
    n: 0,
  });
  expect(runRow(f.store)?.state).toBe("failed");
  // The input survives for the explicit resume that retries it.
  expect(f.store.delivery(delivery).status).toBe("injected");
  f.store.resume("research");
  expect(await supervisor.step("research")).toBe(true);
  expect(f.store.delivery(delivery).status).toBe("handled");
  supervisor.close();
});

it("builds the recovery input inside the run module while the scheduler only owns run lifetime", () => {
  const scheduler = readFileSync("src/runtime/supervisor.ts", "utf8");
  // The scheduler must not assemble memory truncation, checkpoint, task, usage or unknown-operation
  // queries by hand; that knowledge belongs to the run module.
  expect(scheduler).not.toMatch(/FROM agent_checkpoints/);
  expect(scheduler).not.toMatch(/FROM model_usage/);
  expect(scheduler).not.toMatch(/FROM actions WHERE agent_id/);
  expect(scheduler).not.toMatch(/board\.recovery/);
  expect(scheduler).not.toMatch(/Delivery has no trusted work/);
  const module = readFileSync("src/runtime/recovery.ts", "utf8");
  expect(module).toMatch(/FROM agent_checkpoints/);
  expect(module).toMatch(/UsageLedger/);
  expect(module).toMatch(/FROM actions WHERE agent_id/);
  expect(module).toMatch(/board\.recovery/);
  expect(module).toMatch(/class RunRecovery/);
});
