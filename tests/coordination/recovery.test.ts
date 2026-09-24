import { afterEach, expect, it } from "vitest";
import { Store } from "../../src/storage/store.js";
import { Messages, Output, fixtureTarget, externalThread } from "../helpers/canonical-slack.js";
import { configFixture } from "../helpers/config.js";
import { configSchema } from "../../src/config.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { TaskTransitions } from "../../src/coordination/transitions.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
const target = fixtureTarget("CTEST", "100.000001");
function setup() {
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
      {
        ...configFixture.agents[0],
        id: "third",
        name: "Third",
        slackAppId: "ATHREE",
        slackUserId: "UTHREE",
        slackBotId: "BTHREE",
        botTokenEnv: "THIRD_BOT",
        appTokenEnv: "THIRD_APP",
      },
    ],
  });
  const store = new Store(":memory:");
  stores.push(store);
  const messages = new Messages(store, config);
  for (const actor of config.agents.map((agent) => agent.id)) {
    store.register(actor, "v1", []);
    messages.membership(actor, "CTEST", true);
  }
  const output = new Output(messages, { post: async () => ({ ts: "200.000001" }) }),
    c = new Collaboration(store, messages, output, config),
    work = c.createWork("coordination-recovery", target);
  return { store, messages, c, work, output };
}

it("pages every authorized task with query-bound cursors and enforces external installation snapshots", () => {
  const { c, messages, work } = setup();
  const ids = [];
  for (let i = 0; i < 105; i++) ids.push(c.createTask("research", work, target, `task ${i}`));
  const first = c.board.list("research", { relation: "available", limit: 40 });
  expect(first.items).toHaveLength(40);
  expect(first.cursor).toBeTruthy();
  expect(() =>
    c.board.list("research", { relation: "owned", limit: 40, cursor: first.cursor! }),
  ).toThrow("query mismatch");
  const second = c.board.list("research", {
      relation: "available",
      limit: 40,
      cursor: first.cursor!,
    }),
    third = c.board.list("research", { relation: "available", limit: 40, cursor: second.cursor! });
  expect(new Set([...first.items, ...second.items, ...third.items].map((item) => item.id))).toEqual(
    new Set(ids),
  );
  expect(third.cursor).toBeNull();
  expect(third.coverage.historicalComplete).toBe(true);
  const message = {
    team: "TTEST",
    channel: "CTEST",
    thread: externalThread(target),
    ts: externalThread(target),
    revision: externalThread(target),
    text: "installation-private task",
    user: "UOWNER",
    deleted: false,
  };
  messages.record(message, ["research"]);
  const messageTask = c.createTask("research", work, target, "private title", undefined, {
    messageKey: messages.mapper.messageId("CTEST", externalThread(target)),
  });
  expect(c.board.read("research", messageTask).title).toBe("private title");
  expect(() => c.board.read("peer", messageTask)).toThrow("not visible");
  expect(() => c.claim("peer", messageTask)).toThrow("not visible");
});

it("returns a scan continuation instead of exhausting a low-resource request on sparse visibility", () => {
  const { store, c, work } = setup(),
    insert = store.db.prepare(
      "INSERT INTO tasks(id,work_id,target,title,status,created_by,legacy) VALUES(?,?,?,'hidden','draft','research',0)",
    );
  store.atomic(() => {
    for (let i = 0; i < 205; i++)
      insert.run(`z${String(i).padStart(3, "0")}`, work, JSON.stringify(target));
  });
  const first = c.board.list("peer", { relation: "all-visible", limit: 20 });
  expect(first.items).toEqual([]);
  expect(first.cursor).toBeTruthy();
  const second = c.board.list("peer", {
    relation: "all-visible",
    limit: 20,
    cursor: first.cursor!,
  });
  expect(second.items).toEqual([]);
  expect(second.cursor).toBeNull();
});

it("does not widen a failed unpublished task beyond its creator or assignee", () => {
  const { c, work } = setup(),
    id = c.createTask("research", work, target, "unpublished private title"),
    output = c.send("research", work, target, "unpublished", "failed-publication");
  c.draftTask("research", id, output);
  c.store.transitionOutput(output, "pending", "failed", { reason: "synthetic" });
  c.activateDelegations();
  expect(c.task(id).status).toBe("failed");
  expect(() => c.board.read("peer", id)).toThrow("not visible");
  expect(c.board.read("research", id).title).toBe("unpublished private title");
});

it("does not let a transferred parent owner cancel an invisible child draft", () => {
  const { c, work } = setup(),
    parent = c.createTask("research", work, target, "parent");
  c.claim("research", parent);
  const child = c.createTask("research", work, target, "private child", parent),
    output = c.send("research", work, target, "private child", "private-child-output");
  c.draftTask("research", child, output, "peer");
  c.transfer("research", parent, "third", c.task(parent).version);
  expect(() => c.board.read("third", child)).toThrow("not visible");
  expect(() => c.update("third", child, "cancelled", undefined, c.task(child).version)).toThrow(
    "not visible",
  );
  expect(c.task(child).status).toBe("draft");
});

it("keeps peer review in review until an explicit return-for-changes transition", () => {
  const { c, work } = setup(),
    id = c.createTask("research", work, target, "review flow");
  c.claim("research", id);
  c.update("research", id, "review", "implementation evidence");
  let task = c.task(id);
  c.unclaim("research", id, task.version);
  task = c.claim("peer", id, c.task(id).version);
  expect(task.status).toBe("review");
  expect(() => c.transfer("peer", id, "research", task.version)).toThrow("disposition");
  task = c.transfer("peer", id, "research", task.version, "return_for_changes");
  expect(task.status).toBe("doing");
  expect(task.owner).toBe("research");
  expect(() => c.update("research", id, "review", "stale", task.version - 1)).toThrow("version");
  c.update("research", id, "review", "revised evidence", task.version);
  task = c.transfer("research", id, "peer", c.task(id).version, "preserve_review");
  expect(task.status).toBe("review");
  c.update("peer", id, "done", "review passed", task.version);
  expect(c.task(id).status).toBe("done");
  const events = c.board.events("research", id, undefined, 100);
  expect(events.items.map((item) => (item.event as any).action)).toEqual(
    expect.arrayContaining(["claim", "review", "tasks.unclaim", "tasks.transfer", "done"]),
  );
});

it("keeps automatic dependency and work-cancel transitions in the same versioned event stream", () => {
  const { store, c, work } = setup(),
    waiter = c.createTask("research", work, target, "waiter"),
    dependency = c.createTask("peer", work, target, "dependency");
  c.claim("research", waiter);
  c.claim("peer", dependency);
  c.wait("research", waiter, dependency);
  c.update("peer", dependency, "done", "complete");
  expect(c.task(waiter).status).toBe("doing");
  c.control("UOWNER", work, "cancel");
  expect(c.task(waiter).status).toBe("cancelled");
  for (const id of [waiter, dependency]) {
    const task = c.task(id),
      events = store.db
        .prepare("SELECT body FROM task_events WHERE task_id=? ORDER BY id")
        .all(id) as { body: string }[],
      versions = events.map((row) => JSON.parse(row.body).version);
    expect(versions).toEqual(Array.from({ length: task.version + 1 }, (_, i) => i));
  }
  expect(
    (
      store.db
        .prepare("SELECT body FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT 2")
        .all(waiter) as { body: string }[]
    ).map((row) => JSON.parse(row.body).action),
  ).toEqual(["work_cancelled", "dependency_wake"]);
});

it("rolls task state back when event persistence fails at the transition boundary", () => {
  const { store, c, work } = setup(),
    id = c.createTask("research", work, target, "atomic transition"),
    task = c.task(id);
  store.db.exec(
    `CREATE TRIGGER reject_task_event BEFORE INSERT ON task_events WHEN NEW.task_id='${id}' BEGIN SELECT RAISE(ABORT,'event rejected'); END`,
  );
  expect(() =>
    new TaskTransitions(store).change(
      task,
      { owner: "research", status: "doing" },
      { action: "claim", actor: "research" },
    ),
  ).toThrow("event rejected");
  expect(c.task(id)).toMatchObject({ owner: null, status: "todo", version: 0 });
});

it("records private reminder transport and semantic result separately with independent cursors", () => {
  const { store, c, work, output } = setup();
  let reminder = c.reminders.create("research", work, {
    target,
    content: "refresh private notes",
    nextAt: 1000,
    timezone: "UTC",
    cron: "* * * * *",
  });
  for (let i = 0; i < 55; i++) c.tick(1000 + i * 60000);
  expect(output.ready()).toEqual([]);
  const payloads = (
    store.db
      .prepare("SELECT payload FROM deliveries WHERE json_extract(payload,'$.kind')='reminder'")
      .all() as { payload: string }[]
  ).map((row) => JSON.parse(row.payload));
  expect(payloads).toHaveLength(55);
  expect(payloads[0].firingId).toMatch(/^reminder:/);
  const run = store.beginRun("research")!;
  store.input(run, {});
  store.finish(run);
  const first = c.reminders.log("research", reminder.id) as any;
  expect(first.firings).toHaveLength(50);
  expect(first.firingCursor).toBeTruthy();
  const second = c.reminders.log("research", reminder.id, undefined, first.firingCursor) as any;
  expect(second.firings).toHaveLength(5);
  expect(
    [...first.firings, ...second.firings].find((item: any) => item.delivery_id === run.deliveryId),
  ).toMatchObject({
    delivery_status: "handled",
    run_id: run.id,
    run_status: "complete",
    receipt_status: null,
    result_status: null,
  });
  const firingId = payloads[0].firingId,
    done = c.reminders.finish("research", firingId, "deferred", "Need a fresh source");
  expect(done).toMatchObject({ status: "deferred", deferredDoesNotReschedule: true });
  expect(c.reminders.finish("research", firingId, "deferred", "Need a fresh source")).toEqual(done);
  expect(() => c.reminders.finish("research", firingId, "completed")).toThrow("conflict");
  reminder = c.reminders.read("research", reminder.id);
  for (let i = 0; i < 55; i++)
    (c.reminders.edit("research", reminder.id, reminder.version, {
      target,
      content: `purpose ${i}`,
      nextAt: 999999999 + i,
      timezone: "UTC",
    }),
      (reminder = c.reminders.read("research", reminder.id)));
  const eventPage = c.reminders.log("research", reminder.id) as any;
  expect(eventPage.events).toHaveLength(50);
  expect(eventPage.eventCursor).toBeTruthy();
  expect(
    (c.reminders.log("research", reminder.id, eventPage.eventCursor) as any).events.length,
  ).toBeGreaterThan(0);
});

it("uses bounded ordering indexes for task, event and firing pages", () => {
  const { store, c, work } = setup(),
    id = c.createTask("research", work, target, "indexed");
  c.claim("research", id);
  c.reminders.create("research", work, {
    target,
    content: "indexed reminder",
    nextAt: 10,
    timezone: "UTC",
  });
  const plans = [
    store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM tasks INDEXED BY task_list_owner WHERE (? IS NULL OR id<?) AND owner=? ORDER BY id DESC LIMIT 101",
      )
      .all(null, null, "research"),
    store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM tasks INDEXED BY task_list_available WHERE (? IS NULL OR id<?) AND owner IS NULL AND status IN ('todo','review') AND (assigned_to IS NULL OR assigned_to=?) ORDER BY id DESC LIMIT 101",
      )
      .all(null, null, "research"),
    store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id,at,body FROM task_events WHERE task_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT 51",
      )
      .all(id, null, null),
    store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM reminder_firings WHERE reminder_id=? ORDER BY due_at DESC,version DESC,id DESC LIMIT 51",
      )
      .all("missing"),
  ].flat() as { detail: string }[];
  const details = plans.map((row) => row.detail).join("\n");
  expect(details).not.toContain("USE TEMP B-TREE");
  expect(details).toContain("task_list_owner");
  expect(details).toContain("task_events_page");
  expect(details).toMatch(/reminder_firings_(page|2)/);
});
