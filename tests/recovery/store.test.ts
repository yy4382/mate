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
  // A failure nobody classified is not safe to retry by itself: its channel is held for a person
  // with the disposition that names their next action, and no automatic attempt is scheduled.
  db.finish(run, "model unavailable");
  expect(db.resumeState("alice")).toEqual({ attempt: 0, nextAttemptAt: 0, hold: "no_retry" });
  expect(db.db.prepare("SELECT state,stop_reason,error FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "failed",
    stop_reason: "model_failure",
    error: "model unavailable",
  });
  expect(db.runnable("alice", Date.now())).toBe(false);
  expect(db.beginRun("alice")).toBeUndefined();
  db.resume("alice");
  expect(db.resumeState("alice")).toEqual({ attempt: 0, nextAttemptAt: 0, hold: null });
  expect(db.runnable("alice", Date.now())).toBe(true);
  expect(db.beginRun("alice")).toBeDefined();
});
it("a transient failure keeps its work and its next attempt time across a restart", () => {
  const path = join(temporary(), "state.sqlite");
  let db = open(path);
  const session = seed(db);
  const delivery = db.enqueue("alice", "one", { text: "recover me" });
  let run = db.beginRun("alice", 1_000)!;
  db.input(run, { role: "user", content: "recover me" });
  db.finish(run, "model/transient_model: provider rate limited", "model_failure", {
    resume: {
      kind: "retry",
      attempt: 1,
      nextAt: 60_000,
      reason: "model/transient_model: provider rate limited",
    },
  });
  // The attempt ended; the work did not. The delivery stays available for the next attempt.
  expect(db.delivery(delivery).status).toBe("injected");
  expect(db.resumeState("alice")).toEqual({
    attempt: 1,
    nextAttemptAt: 60_000,
    hold: "retry_backoff",
  });
  // Dense retrying stops at the stored next attempt time, not at the end of the failed attempt.
  expect(db.runnable("alice", 59_999)).toBe(false);
  expect(db.beginRun("alice", 59_999)).toBeUndefined();
  db.close();

  // A restart neither loses the pending work nor restarts the interval from zero.
  db = open(path);
  db.recover();
  expect(db.resumeState("alice")).toMatchObject({ attempt: 1, nextAttemptAt: 60_000 });
  expect(db.runnable("alice", 59_999)).toBe(false);
  expect(db.beginRun("alice", 59_999)).toBeUndefined();
  const retry = db.beginRun("alice", 60_000)!;
  expect(retry.deliveryId).toBe(delivery);
  expect(retry.sessionId).toBe(session);
  expect(db.journal(session)).toHaveLength(2);
  // A run that finishes is healthy again, so the next failure waits the first interval.
  db.finish(retry);
  expect(db.resumeState("alice")).toEqual({ attempt: 0, nextAttemptAt: 0, hold: null });
  expect(db.runnable("alice", 60_000)).toBe(true);
});
it("a person's stop overrides a scheduled attempt and an explicit resume clears it", () => {
  const db = open();
  seed(db);
  const delivery = db.enqueue("alice", "one", {});
  const run = db.beginRun("alice", 1_000)!;
  db.finish(run, "model/transient_model: unreachable", "model_failure", {
    resume: { kind: "retry", attempt: 3, nextAt: 600_000, reason: "unreachable" },
  });
  db.pause("alice");
  // The stop cancels the automatic attempt, and the durable work stays for the human's next resume.
  expect(db.resumeState("alice")).toEqual({ attempt: 0, nextAttemptAt: 0, hold: null });
  expect(db.runnable("alice", 600_000)).toBe(false);
  expect(db.beginRun("alice", 600_000)).toBeUndefined();
  expect(db.delivery(delivery).status).toBe("pending");
  db.resume("alice");
  expect(db.runnable("alice", 1_000)).toBe(true);
  expect(db.beginRun("alice", 1_000)).toBeDefined();
});
it("keeps a hold a person still has to release while dropping a work item's schedule", () => {
  const db = open();
  seed(db);
  const delivery = db.enqueue("alice", "one", {});
  // The delivery belongs to one work item, as the collaboration module binds it in production.
  db.db.prepare("INSERT INTO works(id,origin,target) VALUES('work-one','test','{}')").run();
  db.db.prepare("INSERT INTO delivery_work VALUES(?,?)").run(delivery, "work-one");
  const first = db.beginRun("alice", 1_000)!;
  db.finish(first, "model/credential_config: rejected", "model_failure", {
    resume: { kind: "hold", hold: "human_action", reason: "model/credential_config: rejected" },
  });
  // A person stopping the Agent now does not erase why it needed one: the credential problem did
  // not go away, so the hold stays visible while the pause is what stops the channel.
  db.pause("alice");
  expect(db.resumeState("alice")).toEqual({
    attempt: 0,
    nextAttemptAt: 0,
    hold: "human_action",
  });
  db.resume("alice");
  expect(db.resumeState("alice")).toEqual({ attempt: 0, nextAttemptAt: 0, hold: null });

  // Stopping or cancelling the work item drops a scheduled attempt for the Agents whose unfinished
  // delivery belongs to it: no stored instant may survive a stop and bring the Agent back later.
  const run = db.beginRun("alice", 1_000)!;
  db.finish(run, "model/transient_model: provider rate limited", "model_failure", {
    resume: { kind: "retry", attempt: 2, nextAt: 900_000, reason: "rate limited" },
  });
  expect(db.resumeState("alice")).toMatchObject({ attempt: 2, nextAttemptAt: 900_000 });
  db.dropScheduledAttempts("work-one");
  expect(db.resumeState("alice")).toEqual({ attempt: 0, nextAttemptAt: 0, hold: null });
  const released = db.beginRun("alice", 1_000)!;
  expect(released).toBeDefined();
  db.input(released, { role: "user", content: "released" });
  db.finish(released);

  // A second work item this Agent is still working on keeps the wait its own failure earned: the
  // stop only releases the channel when there is nothing else active for this Agent to run.
  const third = db.enqueue("alice", "three", {});
  db.db.prepare("INSERT INTO delivery_work VALUES(?,?)").run(third, "work-one");
  const other = db.enqueue("alice", "two", {});
  db.db.prepare("INSERT INTO works(id,origin,target) VALUES('work-two','test-two','{}')").run();
  db.db.prepare("INSERT INTO delivery_work VALUES(?,?)").run(other, "work-two");
  const waiting = db.beginRun("alice", 1_000)!;
  db.finish(waiting, "model/transient_model: provider rate limited", "model_failure", {
    resume: { kind: "retry", attempt: 2, nextAt: 900_000, reason: "rate limited" },
  });
  db.dropScheduledAttempts("work-one");
  expect(db.resumeState("alice")).toMatchObject({ attempt: 2, nextAttemptAt: 900_000 });

  // Once nothing else of this Agent is active, stopping the work releases the wait it stopped for.
  db.db.prepare("UPDATE works SET state='paused' WHERE id='work-two'").run();
  db.dropScheduledAttempts("work-one");
  expect(db.resumeState("alice")).toEqual({ attempt: 0, nextAttemptAt: 0, hold: null });
});
it("adds no hold to an attempt that a stop already governs", () => {
  const db = open();
  seed(db);
  const delivery = db.enqueue("alice", "one", {});
  const run = db.beginRun("alice", 1_000)!;
  db.finish(run, "worker/aborted: the run was aborted", "model_failure", {
    resume: { kind: "none", reason: "worker/aborted: the run was aborted" },
  });
  // The delivery waits for the next run of the same channel rather than for a person to release it.
  expect(db.resumeState("alice")).toEqual({ attempt: 0, nextAttemptAt: 0, hold: null });
  expect(db.delivery(delivery).status).toBe("pending");
  expect(db.runnable("alice", 1_000)).toBe(true);
  expect(db.beginRun("alice", 1_000)).toBeDefined();
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
