import { fixtureTarget, externalThread } from "../helpers/canonical-slack.js";
import { afterEach, expect, it } from "vitest";
import { Store } from "../../src/storage/store.js";
import { Messages, Output, migrateCurrentRuntime } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { configSchema } from "../../src/config.js";
import { configFixture } from "../helpers/config.js";
const stores: Store[] = [];
const target = fixtureTarget("CTEST", "100.000001");
function setup() {
  const config = configSchema.parse({
    ...configFixture,
    agents: [
      configFixture.agents[0],
      {
        ...configFixture.agents[0],
        id: "engineer",
        slackAppId: "ATWO",
        slackBotId: "BTWO",
        slackUserId: "UTWO",
        botTokenEnv: "ENGINEER_BOT",
        appTokenEnv: "ENGINEER_APP",
      },
    ],
  });
  const db = new Store(":memory:");
  stores.push(db);
  const messages = new Messages(db, config);
  migrateCurrentRuntime(db);
  for (const a of config.agents) {
    db.register(a.id, "v1", []);
    messages.membership(a.id, "CTEST", true);
  }
  const output = new Output(messages, {
    post: async () => ({ ts: "101.000001" }),
  });
  const service = new Collaboration(db, messages, output, config);
  const work = service.createWork("human:one", target);
  return { db, service, work, output };
}
afterEach(() => stores.splice(0).forEach((s) => s.close()));
it("claim has exactly one owner; waiting keeps ownership and dependency completion wakes once", () => {
  const { db, service, work } = setup();
  const parent = service.createTask("research", work, target, "research");
  service.claim("research", parent);
  expect(() => service.claim("engineer", parent)).toThrow("claimed");
  const child = service.createTask("research", work, target, "verify", parent);
  service.claim("engineer", child);
  expect(() => service.wait("engineer", child, parent)).toThrow("cycle");
  service.wait("research", parent, child);
  expect(service.task(parent).owner).toBe("research");
  expect(() => service.wait("engineer", child, parent)).toThrow("cycle");
  expect(() => service.update("research", parent, "done", "premature")).toThrow("Unfinished");
  service.update("engineer", child, "done", "synthetic evidence");
  expect(service.task(parent).status).toBe("doing");
  expect(db.db.prepare("SELECT count(*) n FROM deliveries").get()).toEqual({
    n: 1,
  });
  expect(() => service.update("engineer", child, "done", "duplicate")).toThrow("terminal");
  service.update("research", parent, "done", "final evidence");
});
it("delegation remains unclaimable until visible send, inherits root and activates once", async () => {
  const { db, service, work, output } = setup();
  const parent = service.createTask("research", work, target, "parent");
  service.claim("research", parent);
  const child = service.delegate("research", parent, "engineer", "challenge hypothesis");
  expect(service.task(child).work_id).toBe(work);
  expect(() => service.claim("engineer", child)).toThrow("unavailable");
  service.activateDelegations();
  expect(service.task(child).status).toBe("draft");
  await output.send(service.task(child).outbox_id!);
  service.activateDelegations();
  service.activateDelegations();
  service.claim("engineer", child);
  expect(
    db.db.prepare("SELECT count(*) n FROM deliveries WHERE dedupe LIKE 'delegate:%'").get(),
  ).toEqual({ n: 1 });
  expect(db.db.prepare("SELECT DISTINCT work_id FROM delivery_work").all()).toEqual([
    { work_id: work },
  ]);
});
it("a run binds to its delivery work across recovery without an allowance gate", () => {
  const { db, service, work } = setup();
  service.enqueue("research", work, "one", {});
  const run = db.beginRun("research")!;
  service.bindRunWork(run, work);
  expect(service.currentWork(run, work)).toBe(work);
  db.recover();
  const next = db.beginRun("research")!;
  service.bindRunWork(next, work);
  expect(service.currentWork(next, work)).toBe(work);
  db.input(next, {});
  db.finish(next);
  service.enqueue("engineer", work, "third", {});
  const third = db.beginRun("engineer")!;
  service.bindRunWork(third, work);
});
it("cancelled work cannot be resumed after a bound run is interrupted", () => {
  const { db, service, work } = setup();
  service.enqueue("research", work, "one", {});
  const run = db.beginRun("research")!;
  service.bindRunWork(run, work);
  service.control("UOWNER", work, "cancel");
  expect(service.work(work).state).toBe("cancelled");
  expect(() => service.control("UOWNER", work, "resume")).toThrow("cannot resume");
});
it("failed visible delegation releases parent and draft may be cancelled by its creator", () => {
  const { db, service, work } = setup();
  const parent = service.createTask("research", work, target, "parent");
  service.claim("research", parent);
  const child = service.delegate("research", parent, "engineer", "verify");
  service.wait("research", parent, child);
  db.transitionOutput(service.task(child).outbox_id!, "pending", "failed", {
    reason: "not_in_channel",
  });
  service.activateDelegations();
  service.activateDelegations();
  expect(service.task(child).status).toBe("failed");
  expect(service.task(parent).status).toBe("doing");
  const another = service.delegate("research", parent, "engineer", "second");
  service.update("research", another, "cancelled");
  expect(db.output(service.task(another).outbox_id!)?.state).toBe("failed");
  service.update("research", parent, "done", "reported failure honestly");
});
it("owner stop fences active work, blocks pending sends, leaves other work runnable", async () => {
  const { db, service, work, output } = setup();
  const id = service.send("research", work, target, "pending");
  service.enqueue("research", work, "one", {});
  const run = db.beginRun("research")!;
  service.bindRunWork(run, work);
  expect(() => service.control("UTWO", work, "pause")).toThrow("Owner only");
  expect(service.control("UOWNER", work, "pause")).toEqual([run.id]);
  expect(() => db.assertRun(run)).toThrow("Stale");
  expect(db.beginRun("research")).toBeUndefined();
  await output.send(id);
  expect(db.output(id)?.state).toBe("pending");
  const other = service.createWork("human:two", target);
  service.enqueue("research", other, "two", {});
  expect(db.beginRun("research")).toBeDefined();
  service.control("UOWNER", work, "cancel");
  await output.send(id);
  expect(db.output(id)?.state).toBe("failed");
  expect(() => service.control("UOWNER", work, "resume")).toThrow("cannot resume");
});
it("wakeups catch up once, retain origin, are transactional and outlive their task", () => {
  const { db, service, work } = setup();
  const task = service.createTask("research", work, target, "watch");
  service.claim("research", task);
  const once = service.schedule("research", work, target, 1000, "Asia/Shanghai", undefined, task);
  const recurring = service.schedule(
    "research",
    work,
    target,
    1000,
    "Asia/Shanghai",
    "* * * * *",
    task,
  );
  db.db.exec(
    "CREATE TRIGGER fail_wake BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'crash'); END;",
  );
  expect(() => service.tick(3600000)).toThrow("crash");
  expect(service.schedules("research").every((s) => s.active === 1)).toBe(true);
  db.db.exec("DROP TRIGGER fail_wake");
  service.tick(3600000);
  service.tick(3600000);
  expect(db.db.prepare("SELECT count(*) n FROM deliveries").get()).toEqual({
    n: 2,
  });
  expect(service.schedules("research").find((s) => s.id === once)?.active).toBe(0);
  expect(service.schedules("research").find((s) => s.id === recurring)?.next_at).toBeGreaterThan(
    3600000,
  );
  service.update("research", task, "cancelled");
  expect(service.schedules("research").find((s) => s.id === recurring)?.active).toBe(1);
  service.cancelSchedule("research", recurring);
  expect(service.schedules("research").every((s) => s.active === 0)).toBe(true);
  expect(() => service.cancelSchedule("engineer", recurring)).toThrow("owned");
});
