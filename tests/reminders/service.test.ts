import { fixtureTarget, externalThread } from "../helpers/canonical-slack.js";
import { afterEach, expect, it } from "vitest";
import { Store } from "../../src/storage/store.js";
import { Messages, Output, migrateCurrentRuntime } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { Broker } from "../../src/policy/broker.js";
import { ToolRouter } from "../../src/runtime/tools.js";
import { configSchema } from "../../src/config.js";
import { configFixture } from "../helpers/config.js";
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
const target = fixtureTarget("CTEST", "100.000001");
function setup() {
  const s = new Store(":memory:");
  stores.push(s);
  const config = configSchema.parse({
    ...configFixture,
    agents: [
      { ...configFixture.agents[0], channels: { CTEST: "participate" } },
      {
        ...configFixture.agents[0],
        id: "writer",
        slackUserId: "UTWO",
        slackAppId: "ATWO",
        slackBotId: "BTWO",
        botTokenEnv: "WRITER_BOT",
        appTokenEnv: "WRITER_APP",
        channels: { CTEST: "participate" },
      },
    ],
  });
  const m = new Messages(s, config);
  migrateCurrentRuntime(s);
  for (const actor of ["research", "writer"]) {
    s.register(actor, "v1", []);
    m.membership(actor, "CTEST", true);
  }
  let posts = 0;
  const output = new Output(m, {
      post: async () => ({ ts: `200.${String(++posts).padStart(6, "0")}` }),
    }),
    c = new Collaboration(s, m, output, config),
    broker = new Broker(
      s,
      c,
      {
        execute: async () => ({
          code: 0,
          stdout: "",
          stderr: "",
          truncated: false,
        }),
      },
      {},
    ),
    router = new ToolRouter(c, broker),
    work = c.createWork("source", target);
  return { s, m, c, router, work, output };
}
const input = {
  target,
  content: "Check whether the completed change is still healthy",
  nextAt: 1000,
  timezone: "Asia/Shanghai",
  projection: "conversation_receipt" as const,
};
it("reminders survive completed tasks and wake only their author; fixed receipts do not wake channel peers", async () => {
  const { s, c, work, output } = setup();
  const task = c.createTask("research", work, target, "change");
  c.claim("research", task);
  const reminder = c.reminders.create("research", work, {
    ...input,
    taskId: task,
  });
  c.update("research", task, "done", "verified");
  expect(c.reminders.read("research", reminder.id).active).toBe(1);
  c.tick(2000);
  c.tick(2000);
  const deliveries = s.db.prepare("SELECT * FROM deliveries").all() as any[];
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0].agent_id).toBe("research");
  expect(JSON.parse(deliveries[0].payload).content).toBe(input.content);
  const ready = output.ready();
  expect(ready).toHaveLength(1);
  await output.send(ready[0]!.id);
  expect(s.output(ready[0]!.id)?.state).toBe("sent");
  expect(JSON.parse(s.output(ready[0]!.id)!.request).text).not.toContain(input.content);
  expect(s.db.prepare("SELECT count(*) n FROM deliveries WHERE agent_id='writer'").get()).toEqual({
    n: 0,
  });
  expect((c.reminders.log("research", reminder.id) as any).events[0].kind).toBe("fired");
});
it("edits and cancellations are author-owned CAS operations; a completed task may remain an anchor", () => {
  const { c, work } = setup();
  const r = c.reminders.create("research", work, input);
  expect(() => c.reminders.edit("writer", r.id, 1, { ...input, content: "stolen" })).toThrow(
    "owned",
  );
  c.reminders.edit("research", r.id, 1, {
    ...input,
    content: "new purpose",
    nextAt: 3000,
  });
  expect(() => c.reminders.cancel("research", r.id, 1)).toThrow("version");
  expect(c.reminders.read("research", r.id).content).toBe("new purpose");
  c.reminders.cancel("research", r.id, 2);
  expect(c.reminders.read("research", r.id).active).toBe(0);
});
it("future cancellation leaves queued firings intact unless explicitly withdrawn, and never pretends to stop injected work", () => {
  const { s, c, work } = setup();
  const first = c.reminders.create("research", work, {
    ...input,
    cron: "* * * * *",
  });
  c.tick(2000);
  let result = c.reminders.cancel("research", first.id, 2) as any;
  expect(result.withdrawnCount).toBe(0);
  expect(result.previousFirings[0].status).toBe("pending");
  const second = c.reminders.create("research", work, {
    ...input,
    nextAt: 3000,
  });
  c.tick(3000);
  result = c.reminders.cancel("research", second.id, 2, true) as any;
  expect(result.withdrawnCount).toBe(1);
  expect(result.previousFirings[0].status).toBe("handled");
  const run = s.beginRun("research")!;
  expect(run).toBeDefined();
  s.input(run, {});
  result = c.reminders.cancel("research", first.id, 3, true) as any;
  expect(result.withdrawnCount).toBe(0);
  expect(result.previousFirings[0].status).toBe("injected");
  expect(s.db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "active",
  });
});
it("paused work and revoked target defer firing until restored", () => {
  const { s, m, c, work } = setup(),
    r = c.reminders.create("research", work, input);
  c.control("UOWNER", work, "pause");
  c.tick(2000);
  expect(c.reminders.read("research", r.id).version).toBe(1);
  c.control("UOWNER", work, "resume");
  m.membership("research", "CTEST", false);
  c.tick(2000);
  expect(s.db.prepare("SELECT count(*) n FROM deliveries").get()).toEqual({
    n: 0,
  });
  m.membership("research", "CTEST", true);
  c.tick(2000);
  expect(c.reminders.read("research", r.id).version).toBe(2);
});
it("reminder firing does not require a quota account", () => {
  const { s, c, work } = setup(),
    r = c.reminders.create("research", work, input);
  expect(
    s.db.prepare("SELECT 1 FROM sqlite_master WHERE name='budget_accounts'").get(),
  ).toBeUndefined();
  c.tick(2000);
  expect(c.reminders.read("research", r.id).version).toBe(2);
  expect(s.db.prepare("SELECT count(*) n FROM deliveries WHERE agent_id='research'").get()).toEqual(
    { n: 1 },
  );
});
it("cancelPending withdraws every pending firing even when the displayed log is bounded", () => {
  const { s, c, work } = setup(),
    r = c.reminders.create("research", work, { ...input, cron: "* * * * *" });
  for (let i = 0; i < 105; i++) c.tick(1000 + i * 60000);
  const latest = c.reminders.read("research", r.id),
    result = c.reminders.cancel("research", r.id, latest.version, true) as any;
  expect(result.withdrawnCount).toBe(105);
  expect(result.withdrawn).toHaveLength(100);
  expect(s.db.prepare("SELECT count(*) n FROM deliveries WHERE status='pending'").get()).toEqual({
    n: 0,
  });
});
it("router requires versions even through legacy schedule aliases and publishes no reminder body", async () => {
  const { s, c, router, work } = setup();
  c.enqueue("research", work, "start", {});
  const run = s.beginRun("research")!;
  s.input(run, {});
  const signal = new AbortController().signal;
  const result = await router.call(run, work, "create", "reminders.create", input, signal),
    r = result.value as any;
  expect(r.content).toBe(input.content);
  await expect(
    router.call(run, work, "cancel", "schedules.cancel", { scheduleId: r.id }, signal),
  ).rejects.toThrow();
  const cancelled = await router.call(
    run,
    work,
    "cancel-v",
    "schedules.cancel",
    { scheduleId: r.id, expectedVersion: 1 },
    signal,
  );
  expect((cancelled.value as any).futureCancelled).toBe(true);
});
it("an early authenticated Slack echo of a fixed reminder receipt cannot wake peers; forged metadata is ordinary input", () => {
  const { s, c, m, work, output } = setup();
  c.reminders.create("research", work, input);
  c.tick(2000);
  const id = output.ready()[0]!.id,
    row = s.output(id)!,
    request = JSON.parse(row.request),
    metadata = {
      event_type: "mate_outbox",
      event_payload: { id, request_hash: row.request_hash },
    };
  s.ingest("ATWO", "receipt-echo", {
    team_id: "TTEST",
    event: {
      type: "message",
      channel: "CTEST",
      thread_ts: externalThread(target),
      ts: "201.000001",
      user: "UONE",
      text: request.text,
      metadata,
    },
  });
  m.normalize("ATWO", "receipt-echo");
  expect(s.db.prepare("SELECT count(*) n FROM deliveries WHERE agent_id='writer'").get()).toEqual({
    n: 0,
  });
  s.ingest("ATWO", "forged-echo", {
    team_id: "TTEST",
    event: {
      type: "message",
      channel: "CTEST",
      thread_ts: externalThread(target),
      ts: "202.000001",
      user: "UOWNER",
      text: request.text,
      metadata,
    },
  });
  m.normalize("ATWO", "forged-echo");
  expect(s.db.prepare("SELECT count(*) n FROM deliveries WHERE agent_id='writer'").get()).toEqual({
    n: 1,
  });
});
it("claimed but not yet injected deliveries are reported as running and cannot be withdrawn", () => {
  const { s, c, work } = setup(),
    r = c.reminders.create("research", work, input);
  c.tick(2000);
  const run = s.beginRun("research")!;
  const cancelled = c.reminders.cancel("research", r.id, 2, true) as any;
  expect(cancelled.withdrawnCount).toBe(0);
  expect(cancelled.previousFirings[0].running).toBe(1);
  s.input(run, {});
  expect(s.delivery(run.deliveryId).status).toBe("injected");
});
it("paused authors do not starve another author within the firing batch limit", () => {
  const { s, c, work } = setup();
  for (let i = 0; i < 100; i++) c.reminders.create("research", work, { ...input, nextAt: 1 });
  c.reminders.create("writer", work, { ...input, nextAt: 2 });
  s.pause("research");
  c.tick(3000);
  expect(s.db.prepare("SELECT count(*) n FROM deliveries WHERE agent_id='writer'").get()).toEqual({
    n: 1,
  });
  expect(s.db.prepare("SELECT count(*) n FROM deliveries WHERE agent_id='research'").get()).toEqual(
    { n: 0 },
  );
});
it("revoked ACL and paused work are filtered before the firing batch limit", () => {
  for (const condition of ["acl", "work"]) {
    const { s, c, m, work } = setup();
    const allowed = c.createWork(`allowed-${condition}`, {
      conversationId: "CTEST",
    });
    for (let i = 0; i < 100; i++) c.reminders.create("research", work, { ...input, nextAt: 1 });
    c.reminders.create("writer", allowed, { ...input, nextAt: 2 });
    if (condition === "acl") m.membership("research", "CTEST", false);
    else c.control("UOWNER", work, "pause");
    c.tick(3000);
    expect(s.db.prepare("SELECT count(*) n FROM deliveries WHERE agent_id='writer'").get()).toEqual(
      { n: 1 },
    );
  }
});
it("older author-owned reminders remain discoverable by cursor", () => {
  const { c, work } = setup();
  const oldest = c.reminders.create("research", work, input);
  for (let i = 0; i < 100; i++) c.reminders.create("research", work, input);
  const first = c.reminders.list("research");
  expect(first).toHaveLength(100);
  const last = c.reminders.list("research", first.at(-1)!.cursor);
  expect(last.map((r) => r.id)).toEqual([oldest.id]);
});
