import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/storage/store.js";
import { localApplication } from "../../src/local/application.js";
import { TeamDirectory } from "../../src/conversations/team-directory.js";
import { Controls } from "../../src/daemon/control.js";
import { LocalConsole } from "../../src/local/console.js";
import { formatControlReply } from "../../src/slack/service.js";
import type { TeamSettings } from "../../src/domain/agents.js";
import { anchoredTask } from "../helpers/canonical-slack.js";
import { recordSlackReadiness } from "../../src/slack/readiness.js";

const settings: TeamSettings = {
  agents: ["alice", "bob"].map((id) => ({
    id,
    name: id,
    role: "colleague",
    model: { provider: "test", id: "test", apiKeyEnv: "TEST_KEY" },
  })),
  ownerUserIds: ["owner"],
  runTimeoutMs: 10000,
};
const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  stores.splice(0).forEach((store) => store.close());
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const store = new Store(":memory:");
  stores.push(store);
  const app = localApplication(store, settings);
  for (const agent of settings.agents) store.register(agent.id, "v1", []);
  const target = app.local!.createRoom("room", ["alice", "bob"], ["owner"]),
    work = app.collaboration.createWork("operations", target);
  return { store, ...app, target, work };
}
function run(f: ReturnType<typeof setup>, actor: string, dedupe: string) {
  f.collaboration.enqueue(actor, f.work, dedupe, { kind: "synthetic" });
  const token = f.store.beginRun(actor, Date.now(), true)!;
  f.store.input(token, { role: "user", content: "PRIVATE_INPUT" });
  return token;
}

it("returns owner-only authoritative status without sensitive bodies and local controls reuse the DTO", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const f = setup(),
    c = f.collaboration,
    s = f.store;
  const task = anchoredTask(c, "alice", f.work, f.target, "PRIVATE_TASK_TITLE");
  c.claim("alice", task);
  c.update("alice", task, "done", "PRIVATE_TASK_RESULT");
  c.reminders.create("alice", f.work, {
    target: f.target,
    content: "PRIVATE_REMINDER_CONTENT",
    nextAt: 0,
    timezone: "UTC",
  });
  c.send("alice", f.work, f.target, "PRIVATE_HELD_OUTPUT", "held-output");
  c.send("alice", f.work, f.target, "PRIVATE_UNKNOWN_OUTPUT", "unknown-output");
  s.transitionOutput("unknown-output", "held", "pending");
  s.transitionOutput("unknown-output", "pending", "sending");
  s.transitionOutput("unknown-output", "sending", "unknown", { secret: "PRIVATE_OUTPUT_RECEIPT" });
  const token = run(f, "alice", "first");
  s.prepareAction(token, "action", { secret: "PRIVATE_ACTION_REQUEST" });
  s.startAction(token, "action");
  s.finish(token, "PRIVATE_RUN_ERROR");
  expect(() => c.operations.status("intruder")).toThrow("Owner only");
  const before = {
    deliveries: s.db.prepare("SELECT count(*) n FROM deliveries").get(),
    events: s.db.prepare("SELECT count(*) n FROM conversation_events").get(),
    outbox: s.db.prepare("SELECT count(*) n FROM outbox").get(),
  };
  const status = c.operations.status("owner") as any,
    encoded = JSON.stringify(status);
  expect(status.agents.find((agent: any) => agent.id === "alice")).toMatchObject({
    registered: true,
    paused: true,
  });
  expect(status.uncertainActions.items).toContainEqual({
    id: "action",
    agentId: "alice",
    runId: token.id,
    state: "unknown",
  });
  expect(status.uncertainOutputs.items).toContainEqual({
    id: "unknown-output",
    agentId: "alice",
    state: "unknown",
  });
  expect(status.heldDrafts.items[0]).toMatchObject({
    draftId: "held-output",
    agentId: "alice",
    state: "held",
  });
  expect(status.dueReminders.items[0]).toMatchObject({
    agentId: "alice",
    workId: f.work,
    nextAt: 0,
  });
  for (const secret of [
    "PRIVATE_TASK_TITLE",
    "PRIVATE_TASK_RESULT",
    "PRIVATE_REMINDER_CONTENT",
    "PRIVATE_HELD_OUTPUT",
    "PRIVATE_UNKNOWN_OUTPUT",
    "PRIVATE_OUTPUT_RECEIPT",
    "PRIVATE_ACTION_REQUEST",
    "PRIVATE_RUN_ERROR",
    "PRIVATE_INPUT",
  ])
    expect(encoded).not.toContain(secret);
  const controls = new Controls(c, {} as any, {} as any);
  expect(controls.execute("owner", "status")).toEqual(status);
  expect(
    await new LocalConsole(f.local!, controls).execute({
      id: "status",
      op: "control",
      human: "owner",
      text: "status",
    }),
  ).toEqual({ id: "status", result: status });
  expect({
    deliveries: s.db.prepare("SELECT count(*) n FROM deliveries").get(),
    events: s.db.prepare("SELECT count(*) n FROM conversation_events").get(),
    outbox: s.db.prepare("SELECT count(*) n FROM outbox").get(),
  }).toEqual(before);
});

it("reports each held Agent's recovery wait with its scope, stage and next executable action", () => {
  vi.useFakeTimers();
  vi.setSystemTime(30000);
  const f = setup(),
    c = f.collaboration,
    s = f.store;
  const transient = run(f, "alice", "transient"),
    credential = run(f, "bob", "credential");
  // The supervisor records the shared fault and the resume decision together; the view reads
  // only what is durable.
  s.finish(transient, "PRIVATE_MODEL_ERROR", "model_failure", {
    resume: { kind: "retry", attempt: 2, nextAt: 62000, reason: "PRIVATE_MODEL_ERROR" },
  });
  s.audit("run_failure", {
    agentId: "alice",
    runId: transient.id,
    fault: { stage: "model", category: "transient_model", reason: "provider rate limited" },
    resume: "retry",
  });
  s.finish(credential, "PRIVATE_MODEL_ERROR", "model_failure", {
    resume: { kind: "hold", hold: "human_action", reason: "PRIVATE_MODEL_ERROR" },
  });
  s.audit("run_failure", {
    agentId: "bob",
    runId: credential.id,
    fault: { stage: "worker", category: "credential_config", reason: "model credential rejected" },
    resume: "hold",
  });
  const diagnosis = c.operations.status("owner").diagnosis;
  expect(diagnosis.sources).toEqual({
    daemon: "read",
    slack: "read",
    agents: "read",
    execution: "read",
  });
  // The daemon answering this view is running, and it is reported apart from every other fact.
  expect(diagnosis.daemon).toBe("active");
  expect(diagnosis.conditions).toContainEqual({
    source: "agents",
    scope: { kind: "agent", agentId: "alice" },
    stage: "model",
    need: "automatic_wait",
    reason: "provider rate limited",
    action: null,
    nextAttemptAt: 62000,
  });
  // A credential failure is a configuration fix a person must make, not a wait.
  expect(diagnosis.conditions).toContainEqual({
    source: "agents",
    scope: { kind: "agent", agentId: "bob" },
    stage: "worker",
    need: "configuration_fix",
    reason: "model credential rejected",
    action: "Fix this Agent's model credential or configuration, then agent-resume it.",
    nextAttemptAt: null,
  });
  expect(() => c.operations.status("intruder")).toThrow("Owner only");
});

it("scopes unknown execution results and Slack readiness to the Agent, target and stage each names", () => {
  const f = setup(),
    c = f.collaboration,
    s = f.store,
    token = run(f, "alice", "unknown-run");
  s.prepareAction(token, "unknown-action", { secret: "PRIVATE_ACTION_REQUEST" });
  s.startAction(token, "unknown-action");
  c.send("alice", f.work, f.target, "PRIVATE_UNKNOWN_OUTPUT", "unknown-output");
  s.transitionOutput("unknown-output", "held", "pending");
  s.transitionOutput("unknown-output", "pending", "sending");
  s.transitionOutput("unknown-output", "sending", "unknown", { receipt: "PRIVATE_RECEIPT" });
  recordSlackReadiness(s, {
    updatedAt: 7,
    installations: [
      {
        agentId: "bob",
        state: "needs-human",
        reason: "missing_scope",
        action: "Grant the Slack app of bob the missing scopes and install it again.",
        attempts: 1,
        changedAt: 7,
      },
      {
        agentId: "alice",
        state: "waiting",
        reason: "connection_unavailable",
        nextAttemptAt: 99,
        attempts: 2,
        changedAt: 7,
      },
    ],
    targets: [
      {
        agentId: "alice",
        channel: "C-ROOM",
        conversationId: "room",
        permission: "unconfirmed",
        history: "complete",
        reason: "membership_unconfirmed",
        changedAt: 7,
      },
    ],
  });
  const diagnosis = c.operations.status("owner").diagnosis;
  // An operation that crossed the boundary without a confirmed result has to be verified, and the
  // condition names the Agent, the operation and the run it belongs to.
  expect(diagnosis.conditions).toContainEqual({
    source: "execution",
    scope: { kind: "action", agentId: "alice", actionId: "unknown-action", runId: token.id },
    stage: "execution",
    need: "verify_unknown_effect",
    reason: "This operation crossed the external boundary without a confirmed result",
    action: "Check this operation's recorded result in the Agent's activity; do not repeat it.",
    nextAttemptAt: null,
  });
  expect(diagnosis.conditions).toContainEqual({
    source: "execution",
    scope: { kind: "output", agentId: "alice", outputId: "unknown-output" },
    stage: "execution",
    need: "verify_unknown_effect",
    reason: "This outbound message crossed the external boundary without a confirmed result",
    action: "Check whether this message reached its target before sending it again.",
    nextAttemptAt: null,
  });
  // A permission problem is a configuration fix; a connection that is still coming up is a wait.
  expect(diagnosis.conditions).toContainEqual({
    source: "slack",
    scope: { kind: "slack_installation", agentId: "bob" },
    stage: null,
    need: "configuration_fix",
    reason: "missing_scope",
    action: "Grant the Slack app of bob the missing scopes and install it again.",
    nextAttemptAt: null,
  });
  expect(diagnosis.conditions).toContainEqual({
    source: "slack",
    scope: { kind: "slack_installation", agentId: "alice" },
    stage: null,
    need: "automatic_wait",
    reason: "connection_unavailable",
    action: null,
    nextAttemptAt: 99,
  });
  // A target stays its own scope: it never answers for the installation or for another target.
  expect(diagnosis.conditions).toContainEqual({
    source: "slack",
    scope: {
      kind: "slack_target",
      agentId: "alice",
      channel: "C-ROOM",
      conversationId: "room",
    },
    stage: null,
    need: "automatic_wait",
    reason: "membership_unconfirmed",
    action: null,
    nextAttemptAt: null,
  });
  // The owner's next step comes before the runtime's own waiting.
  expect(diagnosis.conditions.at(-1)!.need).toBe("automatic_wait");
  expect(diagnosis.slack).toMatchObject({ updatedAt: 7 });
  const encoded = JSON.stringify(diagnosis);
  for (const secret of ["PRIVATE_ACTION_REQUEST", "PRIVATE_UNKNOWN_OUTPUT", "PRIVATE_RECEIPT"])
    expect(encoded).not.toContain(secret);
});

it("filters a durable failure record before it reaches owner output", () => {
  const f = setup(),
    c = f.collaboration,
    s = f.store,
    token = run(f, "alice", "secretive");
  s.finish(token, "PRIVATE_RUN_ERROR", "model_failure", {
    resume: { kind: "hold", hold: "human_action", reason: "PRIVATE_RUN_ERROR" },
  });
  s.audit("run_failure", {
    agentId: "alice",
    runId: token.id,
    fault: {
      stage: "model",
      category: "credential_config",
      reason:
        "api key sk-live-PRIVATE0123456789 rejected; SELECT * FROM message_visibility WHERE agent_id='alice'",
    },
    resume: "hold",
  });
  const encoded = JSON.stringify(c.operations.status("owner").diagnosis);
  expect(encoded).not.toContain("PRIVATE0123456789");
  expect(encoded).not.toContain("message_visibility");
  expect(encoded).toContain("model");
});

it("reproduces the same scoped diagnosis from durable records after a restart", () => {
  vi.useFakeTimers();
  vi.setSystemTime(40000);
  const dir = mkdtempSync(join(tmpdir(), "mate-diagnosis-"));
  dirs.push(dir);
  const data = join(dir, "data");
  mkdirSync(join(data, "state"), { recursive: true });
  const path = join(data, "state", "mate.sqlite");
  let store = new Store(path),
    app = localApplication(store, settings);
  for (const agent of settings.agents) store.register(agent.id, "v1", []);
  const target = app.local!.createRoom("room", ["alice", "bob"], ["owner"]),
    work = app.collaboration.createWork("operations", target);
  app.collaboration.enqueue("alice", work, "durable", { kind: "synthetic" });
  const token = store.beginRun("alice", Date.now(), true)!;
  store.prepareAction(token, "durable-action", { secret: "PRIVATE_ACTION_REQUEST" });
  store.startAction(token, "durable-action");
  store.finish(token, "PRIVATE_RUN_ERROR", "model_failure", {
    resume: { kind: "hold", hold: "verify_effect", reason: "PRIVATE_RUN_ERROR" },
  });
  store.audit("run_failure", {
    agentId: "alice",
    runId: token.id,
    fault: {
      stage: "execution",
      category: "unknown_effect",
      reason: "the external effect could not be confirmed",
    },
    resume: "hold",
  });
  recordSlackReadiness(store, {
    updatedAt: 8,
    installations: [
      {
        agentId: "bob",
        state: "connecting",
        reason: "connecting",
        nextAttemptAt: 41000,
        attempts: 1,
        changedAt: 8,
      },
    ],
  });
  const before = app.collaboration.operations.status("owner").diagnosis;
  expect(before.conditions.length).toBeGreaterThanOrEqual(3);
  store.close();

  // A new process opens the same records: nothing in this diagnosis was remembered in memory.
  store = new Store(path);
  stores.push(store);
  const reopened = localApplication(store, settings).collaboration.operations.status(
    "owner",
  ).diagnosis;
  expect({ ...reopened, at: 0 }).toEqual({ ...before, at: 0 });
  expect(reopened.sources).toEqual({
    daemon: "read",
    slack: "read",
    agents: "read",
    execution: "read",
  });
  expect(JSON.stringify(reopened)).not.toContain("PRIVATE_ACTION_REQUEST");
  expect(JSON.stringify(reopened)).not.toContain("PRIVATE_RUN_ERROR");
});

it("reports the same scoped conditions in the activity view without private bodies", () => {
  const f = setup(),
    c = f.collaboration,
    s = f.store,
    token = run(f, "alice", "activity-held");
  s.prepareAction(token, "activity-action", { secret: "PRIVATE_ACTION_REQUEST" });
  s.startAction(token, "activity-action");
  s.finish(token, "PRIVATE_RUN_ERROR", "model_failure", {
    resume: { kind: "hold", hold: "verify_effect", reason: "PRIVATE_RUN_ERROR" },
  });
  s.audit("run_failure", {
    agentId: "alice",
    runId: token.id,
    fault: {
      stage: "execution",
      category: "unknown_effect",
      reason: "the external effect could not be confirmed",
    },
    resume: "hold",
  });
  recordSlackReadiness(s, {
    updatedAt: 9,
    installations: [
      {
        agentId: "bob",
        state: "needs-human",
        reason: "invalid_auth",
        action:
          "Replace the Slack tokens of bob in the Mate service environment, then restart Mate.",
        attempts: 1,
        changedAt: 9,
      },
    ],
  });
  const page = c.operations.activity("owner", {});
  // The activity view carries the daemon fact, Slack readiness and the scoped conditions too.
  expect(page.diagnosis.daemon).toBe("active");
  expect(page.diagnosis.slack?.installations[0]).toMatchObject({
    agentId: "bob",
    state: "needs-human",
  });
  expect(page.diagnosis.conditions).toContainEqual(
    expect.objectContaining({
      source: "slack",
      scope: { kind: "slack_installation", agentId: "bob" },
      need: "configuration_fix",
      action: "Replace the Slack tokens of bob in the Mate service environment, then restart Mate.",
    }),
  );
  expect(page.diagnosis.conditions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: "agents",
        scope: { kind: "agent", agentId: "alice" },
        stage: "execution",
        need: "verify_unknown_effect",
        action:
          "This Agent stopped with an unresolved execution result; check its activity, then agent-resume it.",
      }),
      expect.objectContaining({
        source: "execution",
        scope: {
          kind: "action",
          agentId: "alice",
          actionId: "activity-action",
          runId: token.id,
        },
        stage: "execution",
        need: "verify_unknown_effect",
      }),
    ]),
  );
  const encoded = JSON.stringify(page);
  expect(encoded).not.toContain("PRIVATE_RUN_ERROR");
  expect(encoded).not.toContain("PRIVATE_ACTION_REQUEST");
  expect(() => c.operations.activity("intruder")).toThrow("Owner only");
});

it("merges safe activity with a query-bound vector cursor and never wakes an Agent", () => {
  vi.useFakeTimers();
  vi.setSystemTime(20000);
  const f = setup(),
    c = f.collaboration,
    s = f.store;
  const task = anchoredTask(c, "alice", f.work, f.target, "PRIVATE_TASK");
  c.claim("alice", task);
  c.update("alice", task, "done", "PRIVATE_RESULT");
  const reminder = c.reminders.create("alice", f.work, {
    target: f.target,
    content: "PRIVATE_CONTENT",
    nextAt: 20000,
    timezone: "UTC",
  });
  c.tick(20000);
  const firing = (
    s.db.prepare("SELECT id FROM reminder_firings WHERE reminder_id=?").get(reminder.id) as {
      id: string;
    }
  ).id;
  c.reminders.finish("alice", firing, "completed", "PRIVATE_SUMMARY");
  const token = run(f, "alice", "activity-run");
  s.prepareAction(token, "safe-action", { secret: "PRIVATE_REQUEST" });
  s.startAction(token, "safe-action");
  s.settleAction(token, "safe-action", "failed", { secret: "PRIVATE_RECEIPT" });
  s.finish(token);
  const before = {
    deliveries: s.db.prepare("SELECT count(*) n FROM deliveries").get(),
    events: s.db.prepare("SELECT count(*) n FROM conversation_events").get(),
    facts: s.db.prepare("SELECT count(*) n FROM operational_facts").get(),
  };
  let cursor: string | undefined,
    all: any[] = [];
  do {
    const page = c.operations.activity("owner", { limit: 2, ...(cursor ? { cursor } : {}) });
    all.push(...page.items);
    cursor = page.cursor ?? undefined;
    if (all.length > 100) throw new Error("pagination loop");
  } while (cursor);
  expect(new Set(all.map((item) => `${item.source}:${item.sourceId}`)).size).toBe(all.length);
  expect([...new Set(all.map((item) => item.source))]).toEqual(
    expect.arrayContaining([
      "task",
      "reminder_event",
      "reminder_firing",
      "run",
      "action",
      "runtime",
    ]),
  );
  const encoded = JSON.stringify(all);
  for (const secret of [
    "PRIVATE_TASK",
    "PRIVATE_RESULT",
    "PRIVATE_CONTENT",
    "PRIVATE_SUMMARY",
    "PRIVATE_REQUEST",
    "PRIVATE_RECEIPT",
  ])
    expect(encoded).not.toContain(secret);
  expect(all.find((item) => item.kind === "runtime.run_completed")).toMatchObject({
    actorId: "alice",
    subject: { type: "run", id: token.id },
  });
  const first = c.operations.activity("owner", { limit: 1 });
  expect(first.cursor).toBeTruthy();
  expect(() => c.operations.activity("owner", { limit: 2, cursor: first.cursor! })).toThrow(
    "query mismatch",
  );
  expect(first.sources.runtime!.coverage).toMatchObject({
    historicalComplete: false,
    availableSince: expect.any(Number),
  });
  expect({
    deliveries: s.db.prepare("SELECT count(*) n FROM deliveries").get(),
    events: s.db.prepare("SELECT count(*) n FROM conversation_events").get(),
    facts: s.db.prepare("SELECT count(*) n FROM operational_facts").get(),
  }).toEqual(before);
});

it("rolls runtime and internal DM state back when their required fact cannot commit, then replays facts idempotently", async () => {
  const f = setup(),
    s = f.store,
    token = run(f, "alice", "rollback-run");
  s.db.exec(
    "CREATE TRIGGER reject_runtime_fact BEFORE INSERT ON operational_facts WHEN NEW.source='runtime' BEGIN SELECT RAISE(ABORT,'fact rejected'); END",
  );
  expect(() => s.finish(token)).toThrow("fact rejected");
  expect(s.db.prepare("SELECT state FROM runs WHERE id=?").get(token.id)).toEqual({
    state: "active",
  });
  expect(s.delivery(token.deliveryId).status).toBe("injected");
  s.db.exec("DROP TRIGGER reject_runtime_fact");
  s.finish(token);
  expect(s.db.prepare("SELECT state FROM runs WHERE id=?").get(token.id)).toEqual({
    state: "complete",
  });

  const dmRun = run(f, "alice", "dm-run"),
    directory = new TeamDirectory(f.messages);
  s.db.exec(
    "CREATE TRIGGER reject_dm_fact BEFORE INSERT ON operational_facts WHEN NEW.source='internal_dm' BEGIN SELECT RAISE(ABORT,'dm fact rejected'); END",
  );
  await expect(
    directory.openDM(dmRun, "open-dm", { kind: "agent", id: "bob" }, new AbortController().signal),
  ).rejects.toThrow("dm fact rejected");
  expect(s.db.prepare("SELECT count(*) n FROM internal_dm_pairs").get()).toEqual({ n: 0 });
  expect(s.action("open-dm")).toBeUndefined();
  s.db.exec("DROP TRIGGER reject_dm_fact");
  const target = await directory.openDM(
    dmRun,
    "open-dm",
    { kind: "agent", id: "bob" },
    new AbortController().signal,
  );
  expect(
    await directory.openDM(
      dmRun,
      "open-dm",
      { kind: "agent", id: "bob" },
      new AbortController().signal,
    ),
  ).toEqual(target);
  expect(
    s.db.prepare("SELECT count(*) n FROM operational_facts WHERE source='internal_dm'").get(),
  ).toEqual({ n: 1 });
  const fact = {
    source: "internal_dm" as const,
    sourceId: (target as any).conversationId,
    kind: "internal_dm_created" as const,
    actorId: "alice",
    subject: { type: "internal_dm" as const, id: (target as any).conversationId },
    counts: { members: 2 as const },
  };
  s.atomic(() => s.operationalFact(fact));
  expect(
    s.db.prepare("SELECT count(*) n FROM operational_facts WHERE source='internal_dm'").get(),
  ).toEqual({ n: 1 });
  expect(() => s.atomic(() => s.operationalFact({ ...fact, actorId: "bob" }))).toThrow(
    "identity conflict",
  );
});

it("shows a current-format reminder's activity with complete coverage after an edit", () => {
  const f = setup(),
    c = f.collaboration,
    reminder = c.reminders.create("alice", f.work, {
      target: f.target,
      content: "first purpose",
      nextAt: 50000,
      timezone: "UTC",
    });
  c.reminders.edit("alice", reminder.id, reminder.version, {
    target: f.target,
    content: "edited purpose",
    nextAt: 60000,
    timezone: "UTC",
  });
  expect(c.reminders.read("alice", reminder.id)).toMatchObject({
    content: "edited purpose",
    version: 2,
  });
  const page = c.operations.activity("owner", { sources: ["reminder_event", "reminder_firing"] });
  expect(page.items.map((item) => item.kind)).toEqual(["reminder.edited", "reminder.created"]);
  expect(page.sources).toMatchObject({
    reminder_event: { coverage: { historicalComplete: true, gapCount: 0 } },
    reminder_firing: { coverage: { historicalComplete: true, gapCount: 0 } },
  });
});

it("rolls owner work control back when the centralized runtime fact fails", () => {
  const f = setup(),
    s = f.store,
    token = run(f, "alice", "controlled");
  s.db.exec(
    "CREATE TRIGGER reject_control_fact BEFORE INSERT ON operational_facts WHEN NEW.source='runtime' BEGIN SELECT RAISE(ABORT,'control fact rejected'); END",
  );
  expect(() => f.collaboration.control("owner", f.work, "pause")).toThrow("control fact rejected");
  expect(f.collaboration.work(f.work).state).toBe("active");
  expect(s.db.prepare("SELECT state FROM runs WHERE id=?").get(token.id)).toEqual({
    state: "active",
  });
  expect(
    s.db
      .prepare("SELECT count(*) n FROM operational_facts WHERE source_id=?")
      .get(`${token.id}:interrupted`),
  ).toEqual({ n: 0 });
  s.db.exec("DROP TRIGGER reject_control_fact");
  f.collaboration.control("owner", f.work, "pause");
  expect(s.db.prepare("SELECT state FROM runs WHERE id=?").get(token.id)).toEqual({
    state: "interrupted",
  });
});

it("pages a sparse actor and kind filter without loss or duplicates", () => {
  vi.useFakeTimers();
  vi.setSystemTime(70000);
  const f = setup(),
    c = f.collaboration;
  for (let i = 0; i < 125; i++) {
    anchoredTask(c, "bob", f.work, f.target, `peer ${i}`);
    anchoredTask(c, "alice", f.work, f.target, `own ${i}`);
  }
  let cursor: string | undefined,
    items: any[] = [];
  do {
    const page = c.operations.activity("owner", {
      sources: ["task"],
      actorId: "alice",
      kinds: ["task.create"],
      limit: 17,
      ...(cursor ? { cursor } : {}),
    });
    items.push(...page.items);
    cursor = page.cursor ?? undefined;
  } while (cursor);
  expect(items).toHaveLength(125);
  expect(new Set(items.map((item) => item.sourceId)).size).toBe(125);
  expect(items.every((item) => item.actorId === "alice" && item.kind === "task.create")).toBe(true);
});

it("keeps oversized Slack control responses valid and directs the owner to a narrower query", () => {
  const value = {
    works: {
      items: Array.from({ length: 100 }, (_, i) => ({ id: `work-${i}-${"x".repeat(500)}` })),
      atLeast: 101,
      truncated: true,
    },
  };
  const reply = formatControlReply(value, 1000),
    parsed = JSON.parse(reply);
  expect(Buffer.byteLength(reply)).toBeLessThan(1000);
  expect(parsed).toMatchObject({
    format: "mate.control-overflow.v1",
    truncated: true,
    fields: { works: { atLeast: 101, truncated: true } },
  });
  expect(parsed.hint).toContain("smaller limit");
  expect(JSON.parse(formatControlReply({ ok: true }))).toEqual({ ok: true });
});
