import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/storage/store.js";
const roots: string[] = [],
  stores: Store[] = [];
function open(path?: string) {
  const db = new Store(path ?? ":memory:");
  stores.push(db);
  return db;
}
function temporary() {
  const root = mkdtempSync(join(tmpdir(), "mate-test-"));
  roots.push(root);
  return root;
}
function seed(db: Store, agent = "alice") {
  return db.register(agent, "v1", [{ role: "system", content: "trusted" }]);
}
afterEach(() => {
  for (const db of stores.splice(0)) if (db.db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("dedupes inbox, serializes by Agent across channels, isolates other agents", () => {
  const db = open(),
    session = seed(db);
  seed(db, "bob");
  const first = db.enqueue("alice", "one", { channel: "A" });
  expect(db.enqueue("alice", "one", { channel: "A" })).toBe(first);
  db.enqueue("alice", "two", { channel: "B" });
  db.enqueue("bob", "one", { channel: "A" });
  const a = db.beginRun("alice")!;
  expect(db.beginRun("alice")).toBeUndefined();
  expect(db.beginRun("bob")).toBeDefined();
  db.input(a, { role: "user", content: "A" });
  db.finish(a);
  const next = db.beginRun("alice")!;
  expect(next.sessionId).toBe(session);
  expect(next.id).not.toBe(a.id);
  expect(() => db.appendMessage(a, "late", {})).toThrow("Stale");
});
it("database constraints serialize competing connections and roll back nested state", () => {
  const path = join(temporary(), "state.sqlite"),
    one = open(path),
    two = open(path);
  seed(one);
  one.enqueue("alice", "one", {});
  expect(one.beginRun("alice")).toBeDefined();
  expect(two.beginRun("alice")).toBeUndefined();
  expect(() =>
    one.atomic(() => {
      one.enqueue("alice", "rollback", {});
      throw new Error("injected crash");
    }),
  ).toThrow();
  expect(two.db.prepare("SELECT 1 FROM deliveries WHERE dedupe='rollback'").get()).toBeUndefined();
});
it("input and delivery injection rollback together, idempotent after recovery", () => {
  const db = open();
  const session = seed(db);
  db.enqueue("alice", "one", {});
  const run = db.beginRun("alice")!;
  db.db.exec(
    "CREATE TRIGGER fail_injection BEFORE UPDATE OF status ON deliveries BEGIN SELECT RAISE(ABORT,'disk failure'); END;",
  );
  expect(() => db.input(run, { role: "user", content: "x" })).toThrow("disk failure");
  expect(db.journal(session)).toHaveLength(1);
  expect(db.delivery(run.deliveryId).status).toBe("pending");
  db.db.exec("DROP TRIGGER fail_injection");
  db.input(run, { role: "user", content: "x" });
  db.recover();
  const recovered = db.beginRun("alice")!;
  db.input(recovered, { role: "user", content: "x" });
  expect(db.journal(session)).toHaveLength(2);
  expect(() => db.input(recovered, { role: "user", content: "changed" })).toThrow(
    "different message",
  );
});
it("disk reopen preserves session/context and marks incomplete effects unknown", () => {
  const path = join(temporary(), "state.sqlite");
  let db = open(path);
  const session = seed(db);
  db.enqueue("alice", "one", {});
  const run = db.beginRun("alice")!;
  db.input(run, { role: "user", content: "hello" });
  db.prepareAction(run, "action", { command: "test" });
  db.startAction(run, "action");
  db.db.prepare("INSERT INTO conversation_identities VALUES('A','channel','external')").run();
  db.queueOutput(
    "alice",
    "send",
    { format: "mate.effect.v2", target: { conversationId: "A" }, text: "hello" },
    JSON.stringify({ conversationId: "A" }),
  );
  db.transitionOutput("send", "pending", "sending");
  db.close();
  db = open(path);
  db.recover();
  expect(seed(db)).toBe(session);
  expect(db.journal(session)).toHaveLength(2);
  expect(db.action("action")?.state).toBe("unknown");
  expect(db.output("send")?.state).toBe("unknown");
  expect(() => db.startAction(run, "action")).toThrow("Stale");
  const next = db.beginRun("alice")!;
  expect(() => db.startAction(next, "action")).toThrow("not executable");
  expect(() => db.transitionOutput("send", "unknown", "sending")).toThrow();
});
it("identity conflicts and failed inputs cannot silently succeed or spin", () => {
  const db = open();
  seed(db);
  seed(db, "bob");
  db.enqueue("alice", "one", {});
  const run = db.beginRun("alice")!;
  expect(() => db.finish(run)).toThrow("uninjected");
  db.prepareAction(run, "one", { command: "a" });
  expect(() => db.prepareAction(run, "one", { command: "b" })).toThrow("identity conflict");
  expect(() => db.appendMessage({ ...run, agentId: "bob" }, "forged", {})).toThrow("Stale");
  db.finish(run, "model unavailable");
  expect(db.beginRun("alice")).toBeUndefined();
  db.resume("alice");
  expect(db.beginRun("alice")).toBeDefined();
});
it("recovers prepared intents only, and failed run atomically marks started effects unknown", () => {
  const db = open();
  seed(db);
  db.enqueue("alice", "one", {});
  let run = db.beginRun("alice")!;
  db.input(run, { role: "user", content: "hello" });
  db.prepareAction(run, "prepared", { command: "test" });
  db.recover();
  run = db.beginRun("alice")!;
  expect(() => db.prepareAction(run, "prepared", { command: "changed" })).toThrow(
    "identity conflict",
  );
  db.prepareAction(run, "prepared", { command: "test" });
  db.startAction(run, "prepared");
  expect(() => db.finish(run)).toThrow("executing");
  db.finish(run, "worker crashed");
  expect(db.action("prepared")?.state).toBe("unknown");
  db.resume("alice");
  run = db.beginRun("alice")!;
  db.prepareAction(run, "prepared", { command: "test" });
  expect(() => db.startAction(run, "prepared")).toThrow("not executable");
});
it("stop fences run and preserves injected work; resume gets fresh generation", () => {
  const db = open();
  seed(db);
  db.enqueue("alice", "one", {});
  const run = db.beginRun("alice")!;
  db.input(run, { role: "user", content: "hello" });
  db.pause("alice");
  expect(() => db.finish(run)).toThrow("Stale");
  expect(db.beginRun("alice")).toBeUndefined();
  expect(db.delivery(run.deliveryId).status).toBe("injected");
  db.resume("alice");
  expect(db.beginRun("alice")!.generation).toBeGreaterThan(run.generation);
});
it("snapshot keeps full journal, composes new entries, falls back on corruption, consistent backup reopens", async () => {
  const db = open(join(temporary(), "state.sqlite"));
  const session = seed(db);
  db.snapshot(session, [
    { role: "system", content: "trusted" },
    { role: "user", content: "summary" },
  ]);
  db.enqueue("alice", "one", {});
  const run = db.beginRun("alice")!;
  expect(() => db.snapshot(session, [])).toThrow("idle");
  db.input(run, { role: "user", content: "new" });
  db.finish(run);
  expect(db.context(session)).toHaveLength(3);
  expect(db.journal(session)).toHaveLength(2);
  db.db.prepare("UPDATE snapshots SET body='invalid' WHERE session_id=?").run(session);
  expect(db.context(session)).toEqual(db.journal(session));
  const backup = join(temporary(), "backup.sqlite");
  await db.backup(backup);
  expect(open(backup).journal(session)).toEqual(db.journal(session));
});
