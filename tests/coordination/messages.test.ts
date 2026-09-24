import { fixtureTarget, externalThread } from "../helpers/canonical-slack.js";
import { afterEach, expect, it } from "vitest";
import { Store } from "../../src/storage/store.js";
import { Messages, Output, migrateCurrentRuntime } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { Broker } from "../../src/policy/broker.js";
import { ToolRouter } from "../../src/runtime/tools.js";
import { configFixture } from "../helpers/config.js";
import { configSchema } from "../../src/config.js";
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
const target = fixtureTarget("CTEST", "100.000001"),
  ref = { messageId: target.threadId };
function setup() {
  const config = configSchema.parse({
    ...configFixture,
    agents: [
      configFixture.agents[0],
      {
        ...configFixture.agents[0],
        id: "peer",
        slackAppId: "ATWO",
        slackUserId: "UTWO",
        slackBotId: "BTWO",
        botTokenEnv: "PEER_BOT",
        appTokenEnv: "PEER_APP",
      },
    ],
  });
  const s = new Store(":memory:");
  stores.push(s);
  const m = new Messages(s, config);
  migrateCurrentRuntime(s);
  const c = new Collaboration(
      s,
      m,
      new Output(m, { post: async () => ({ ts: "200.000001" }) }),
      config,
    ),
    router = new ToolRouter(
      c,
      new Broker(
        s,
        c,
        { execute: async () => ({ code: 0, stdout: "", stderr: "", truncated: false }) },
        {},
      ),
    );
  for (const a of config.agents) {
    s.register(a.id, "v1", []);
    m.membership(a.id, "CTEST", true);
  }
  const work = c.createWork("root", target);
  m.record(
    {
      team: "TTEST",
      channel: target.conversationId,
      thread: externalThread(target),
      ts: externalThread(target),
      revision: externalThread(target),
      text: "Canonical request",
      user: "UOWNER",
      deleted: false,
    },
    ["research", "peer"],
  );
  const runs = config.agents.map((a) => {
    c.enqueue(a.id, work, "start", {});
    const r = s.beginRun(a.id)!;
    s.input(r, {});
    return r;
  });
  return { s, m, c, router, work, runs };
}
it("two held claims do not create tasks; informed continuations still arbitrate one canonical owner", () => {
  const { c, router, work, runs } = setup(),
    coord = router.coordination;
  const a = coord.submit(runs[0]!, work, "a", "tasks.claim", {
      message: ref,
      expectedVersion: 0,
    }) as any,
    b = coord.submit(runs[1]!, work, "b", "tasks.claim", {
      message: ref,
      expectedVersion: 0,
    }) as any;
  expect(c.list("research")).toHaveLength(0);
  const applied = coord.continue(runs[0]!, "a", a.holdId) as any;
  expect(applied.result.owner).toBe("research");
  expect(() => coord.continue(runs[1]!, "b", b.holdId)).toThrow("version");
  expect(c.list("research")).toHaveLength(1);
});
it("unclaim and transfer are CAS operations, not freshness overrides of ownership", () => {
  const { c, router, work, runs } = setup(),
    coord = router.coordination;
  const held = coord.submit(runs[0]!, work, "claim", "tasks.claim", {
    message: ref,
    expectedVersion: 0,
  }) as any;
  const task = (coord.continue(runs[0]!, "claim", held.holdId) as any).result;
  const unclaim = coord.submit(runs[0]!, work, "unclaim", "tasks.unclaim", {
    taskId: task.id,
    expectedVersion: task.version,
  }) as any;
  coord.continue(runs[0]!, "unclaim", unclaim.holdId);
  expect(c.task(task.id).owner).toBeNull();
  const again = coord.submit(runs[0]!, work, "again", "tasks.claim", {
    taskId: task.id,
    expectedVersion: c.task(task.id).version,
  }) as any;
  coord.continue(runs[0]!, "again", again.holdId);
  const transfer = coord.submit(runs[0]!, work, "transfer", "tasks.transfer", {
    taskId: task.id,
    peerId: "peer",
    expectedVersion: c.task(task.id).version,
  }) as any;
  coord.continue(runs[0]!, "transfer", transfer.holdId);
  expect(c.task(task.id).owner).toBe("peer");
  const steal = coord.submit(runs[0]!, work, "steal", "tasks.update", {
    taskId: task.id,
    expectedVersion: c.task(task.id).version,
    status: "done",
    result: "claiming credit",
  }) as any;
  expect(() => coord.continue(runs[0]!, "steal", steal.holdId)).toThrow("owned");
});
it("new task remains an unclaimable draft until its canonical message has a visible receipt", async () => {
  const { c, router, work, runs, s, m } = setup();
  const run = runs[0]!,
    task = router.coordination.create(run, work, target, "new independent work");
  expect(task.status).toBe("draft");
  expect(() => c.claim("research", task.id)).toThrow("unavailable");
  const draft = router.gate.describe("research", task.outbox_id!) as any;
  router.gate.continueOnce(run, draft.draftId, 1, draft.holdId);
  await c.output.send(task.outbox_id!);
  c.activateDelegations();
  const active = c.task(task.id);
  expect(active.message_key).toBe(m.mapper.messageId("CTEST", "200.000001"));
  expect(active.status).toBe("todo");
  expect(
    s.db.prepare("SELECT 1 FROM deliveries WHERE dedupe=?").get(`delegate:${task.id}`),
  ).toBeDefined();
});
it("peer claim after visible send but before polling reuses the pending task instead of duplicating it", async () => {
  const { c, router, work, runs } = setup();
  const task = router.coordination.create(runs[0]!, work, target, "new task");
  const draft = router.gate.describe("research", task.outbox_id!) as any;
  router.gate.continueOnce(runs[0]!, draft.draftId, 1, draft.holdId);
  await c.output.send(task.outbox_id!);
  const message = { messageId: c.messages.records.confirmedMessageId(task.outbox_id!) };
  const visible = router.coordination.find("peer", message)!;
  const held = router.coordination.submit(runs[1]!, work, "race", "tasks.claim", {
    message,
    expectedVersion: visible.version,
  }) as any;
  const applied = router.coordination.continue(runs[1]!, "race", held.holdId) as any;
  expect(applied.result.id).toBe(task.id);
  expect(applied.result.owner).toBe("peer");
  expect(() => c.activateDelegations()).not.toThrow();
  expect(c.list("research")).toHaveLength(1);
});
it("a top-level created task can be claimed by ID using the confirmed root thread", async () => {
  const { c, router, work, runs } = setup();
  const task = router.coordination.create(
    runs[0]!,
    work,
    { conversationId: "CTEST" },
    "top-level task",
  );
  const draft = router.gate.describe("research", task.outbox_id!) as any;
  router.gate.continueOnce(runs[0]!, draft.draftId, 1, draft.holdId);
  await c.output.send(task.outbox_id!);
  c.activateDelegations();
  const held = router.coordination.submit(runs[0]!, work, "claim-top", "tasks.claim", {
    taskId: task.id,
    expectedVersion: c.task(task.id).version,
  }) as any;
  expect(
    (router.coordination.continue(runs[0]!, "claim-top", held.holdId) as any).result.owner,
  ).toBe("research");
});
it("completing a dependency persists the wakeup while its waiter activity is paused", () => {
  const { s, c, work, runs } = setup();
  const other = c.createWork("other", target),
    waiter = c.createTask("research", work, target, "wait"),
    dependency = c.createTask("peer", other, target, "dependency");
  c.claim("research", waiter);
  c.claim("peer", dependency);
  c.wait("research", waiter, dependency);
  c.control("UOWNER", work, "pause");
  c.update("peer", dependency, "done", "finished");
  expect(c.task(dependency).status).toBe("done");
  expect(
    s.db
      .prepare(
        "SELECT count(*) n FROM deliveries WHERE json_extract(payload,'$.kind')='dependency'",
      )
      .get(),
  ).toEqual({ n: 1 });
  expect(s.beginRun("research", Date.now(), true)).toBeUndefined();
  c.control("UOWNER", work, "resume");
  expect(s.beginRun("research", Date.now(), true)).toBeDefined();
});
it("waiting is a gated CAS mutation and only releases the run after applying", async () => {
  const { c, router, work, runs } = setup(),
    task = c.createTask("research", work, target, "wait"),
    dependency = c.createTask("peer", work, target, "dep");
  c.claim("research", task);
  const signal = new AbortController().signal;
  const held = await router.call(
    runs[0]!,
    work,
    "wait",
    "tasks.wait",
    { taskId: task, dependencyId: dependency, expectedVersion: c.task(task).version },
    signal,
  );
  expect(held.wait).toBe(false);
  expect(c.task(task).status).toBe("doing");
  const value = held.value as any;
  const applied = await router.call(
    runs[0]!,
    work,
    "apply-wait",
    "tasks.continue",
    {
      intentId: value.intentId,
      holdId: value.holdId,
      acknowledge: "apply_despite_unread_or_changes",
    },
    signal,
  );
  expect(applied.wait).toBe(true);
  expect(c.task(task).status).toBe("waiting");
});
it("waiting on a terminal dependency is a no-op or releases an existing wait without duplicate projection", () => {
  const { c, router, work, runs } = setup(),
    coord = router.coordination,
    run = runs[0]!;
  const held = coord.submit(run, work, "claim", "tasks.claim", {
    message: ref,
    expectedVersion: 0,
  }) as any;
  const task = (coord.continue(run, "claim", held.holdId) as any).result;
  const done = c.createTask("peer", work, target, "done"),
    pending = c.createTask("peer", work, target, "pending");
  c.claim("peer", done);
  c.update("peer", done, "done", "finished");
  const first = coord.submit(run, work, "wait-done", "tasks.wait", {
    taskId: task.id,
    dependencyId: done,
    expectedVersion: task.version,
  }) as any;
  expect((coord.continue(run, "wait-done", first.holdId) as any).result.status).toBe("doing");
  c.wait("research", task.id, pending);
  const next = coord.submit(run, work, "release", "tasks.wait", {
    taskId: task.id,
    dependencyId: done,
    expectedVersion: c.task(task.id).version,
  }) as any;
  expect((coord.continue(run, "release", next.holdId) as any).result.status).toBe("doing");
  expect(c.task(task.id).waiting_on).toBeNull();
});
