import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, encode } from "../../src/storage/store.js";
import { Messages, Output } from "../fixtures/v16/src/slack/messages.js";
import { Collaboration } from "../fixtures/legacy/collaboration.js";
import { migrateCanonicalConversations } from "../../src/slack/canonical-migration.js";
import { configFixture } from "../helpers/config.js";
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);

it("converts mutable references atomically, preserves evidence and reopens twice without rerunning legacy interpretation", () => {
  const dir = mkdtempSync(join(tmpdir(), "mate-canonical-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  const s = new Store(path);
  s.register("research", "legacy", [{ role: "user", content: "synthetic original context" }]);
  const m = new Messages(s, configFixture),
    c = new Collaboration(
      s,
      m,
      new Output(m, { post: async () => ({ ts: "5.000001" }) }),
      configFixture,
    );
  m.membership("research", "CTEST", true);
  m.record(
    {
      team: "TTEST",
      channel: "CTEST",
      ts: "2.000001",
      thread: "1.000001",
      revision: "3.000001",
      text: "request",
      user: "UOWNER",
      deleted: false,
    },
    ["research"],
  );
  const target = { channel: "CTEST", thread: "1.000001" },
    key = encode(["TTEST", "CTEST", "2.000001"]);
  const work = c.createWork("synthetic", target);
  c.createTask("research", work, target, "task");
  c.reminders.create("research", work, {
    target,
    content: "follow up",
    nextAt: Date.now() + 60000,
    timezone: "UTC",
    anchor: { channel: "CTEST", ts: "2.000001" },
  });
  m.watch("research", target, true);
  c.attention.state("research", target, "defer", Date.now() + 60000);
  s.db.prepare("INSERT INTO attention_seen VALUES(?,?,?)").run("research", key, "3.000001");
  c.send("research", work, target, "wire", "output");
  s.transitionOutput("output", "pending", "sending");
  s.transitionOutput("output", "sending", "unknown", { reason: "timeout" });
  const before = {
    output: s.output("output"),
    body: s.db.prepare("SELECT body FROM messages").get(),
    revisions: s.db.prepare("SELECT body FROM message_revisions").all(),
    journal: s.db.prepare("SELECT * FROM entries").all(),
    delivery: s.db.prepare("SELECT id,dedupe,status FROM deliveries").all(),
    seq: s.db.prepare("SELECT seq FROM conversation_events").all(),
    state: s.db.prepare("SELECT resolved,deferred_until,muted FROM attention_state").get(),
  };
  migrateCanonicalConversations(s, configFixture);
  expect(s.db.pragma("user_version", { simple: true })).toBe(17);
  expect(s.db.prepare("SELECT ts,thread,revision FROM messages").get()).toEqual({
    ts: "2000001",
    thread: encode(["TTEST", "CTEST", "1.000001"]),
    revision: "3000001",
  });
  expect(s.db.prepare("SELECT revision FROM attention_seen").get()).toEqual({
    revision: "3000001",
  });
  expect(
    JSON.parse((s.db.prepare("SELECT target FROM works").get() as { target: string }).target),
  ).toEqual({ conversationId: "CTEST", threadId: encode(["TTEST", "CTEST", "1.000001"]) });
  expect(s.output("output")).toEqual(before.output);
  expect(s.db.prepare("SELECT body FROM messages").get()).toEqual(before.body);
  expect(s.db.prepare("SELECT body FROM message_revisions").all()).toEqual(before.revisions);
  expect(s.db.prepare("SELECT * FROM entries").all()).toEqual(before.journal);
  expect(s.db.prepare("SELECT id,dedupe,status FROM deliveries").all()).toEqual(before.delivery);
  expect(s.db.prepare("SELECT seq FROM conversation_events").all()).toEqual(before.seq);
  expect(s.db.prepare("SELECT resolved,deferred_until,muted FROM attention_state").get()).toEqual(
    before.state,
  );
  const epoch = s.db.prepare("SELECT context_epoch FROM sessions").get();
  s.close();
  for (let count = 0; count < 2; count++) {
    const reopened = new Store(path);
    try {
      migrateCanonicalConversations(reopened, configFixture);
      expect(reopened.output("output")).toEqual(before.output);
      expect(reopened.db.prepare("SELECT context_epoch FROM sessions").get()).toEqual(epoch);
    } finally {
      reopened.close();
    }
  }
});

it("keeps an unresolved root null and rolls schema/data/format back on invalid legacy evidence", () => {
  const s = new Store(":memory:");
  cleanup.push(() => s.close());
  s.register("research", "legacy", []);
  const m = new Messages(s, configFixture);
  m.record(
    {
      team: "TTEST",
      channel: "CTEST",
      ts: "1.000001",
      thread: "1.000001",
      revision: "2.000001",
      text: "",
      deleted: true,
    },
    [],
  );
  const original = s.db.prepare("SELECT * FROM messages").all();
  s.db
    .prepare("INSERT INTO attention_seen VALUES(?,?,?)")
    .run("research", encode(["TTEST", "CTEST", "1.000001"]), "invalid-revision");
  expect(() => migrateCanonicalConversations(s, configFixture)).toThrow(
    "Invalid legacy message revision",
  );
  expect(s.db.pragma("user_version", { simple: true })).toBe(16);
  expect(
    s.db.prepare("SELECT * FROM runtime_meta WHERE key='conversation_format'").get(),
  ).toBeUndefined();
  expect(s.db.prepare("SELECT * FROM messages").all()).toEqual(original);
  s.db.prepare("DELETE FROM attention_seen").run();
  migrateCanonicalConversations(s, configFixture);
  expect(s.db.prepare("SELECT thread FROM messages").get()).toEqual({ thread: null });
});

it("reads mixed versioned bodies and effects without falling back for unknown format markers", () => {
  const s = new Store(":memory:");
  cleanup.push(() => s.close());
  s.register("research", "legacy", []);
  const m = new Messages(s, configFixture),
    records = m.persistence.records;
  m.record(
    {
      team: "TTEST",
      channel: "CTEST",
      ts: "1.000001",
      thread: "1.000001",
      revision: "1.000001",
      text: "original",
      user: "UOWNER",
      deleted: false,
    },
    [],
  );
  const id = encode(["TTEST", "CTEST", "1.000001"]);
  migrateCanonicalConversations(s, configFixture);
  const old = records.message(id)!;
  expect(old.order).toBe("1000001");
  s.db
    .prepare("UPDATE messages SET body=? WHERE key=?")
    .run(encode({ format: "mate.message.v2", message: { ...old, text: "canonical update" } }), id);
  expect(records.message(id)?.text).toBe("canonical update");
  s.db
    .prepare("UPDATE messages SET body=? WHERE key=?")
    .run(encode({ format: "mate.message.v999", message: old }), id);
  expect(() => records.message(id)).toThrow("Unsupported stored message format");
  s.queueOutput(
    "research",
    "future",
    { format: "mate.effect.v999", target: { conversationId: "CTEST" }, text: "not a v1 fallback" },
    encode({ conversationId: "CTEST" }),
  );
  expect(() => records.targetedEffect("outbox", "future")).toThrow(
    "Unsupported stored effect format",
  );
});
