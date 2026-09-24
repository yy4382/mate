import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, encode } from "../../src/storage/store.js";
import { Messages, Output } from "../fixtures/v16/src/slack/messages.js";
import { Collaboration } from "../fixtures/legacy/collaboration.js";
import { FreshnessGate } from "../fixtures/v16/src/conversations/freshness.js";
import { References } from "../../src/conversations/references.js";
import { migrateLegacyReferences } from "../../src/slack/reference-migration.js";
import { configFixture } from "../helpers/config.js";
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function setup(path = ":memory:") {
  const s = new Store(path);
  cleanup.push(() => s.close());
  s.register("research", "test", []);
  const m = new Messages(s, configFixture),
    output = new Output(m, { post: async () => ({ ts: "50.000001" }) });
  const c = new Collaboration(s, m, output, configFixture);
  m.membership("research", "CTEST", true);
  m.membership("research", "CTWO", true);
  return { s, m, output, c, refs: new References(s) };
}
it("keeps legacy unknown evidence after reopen and blocks new overlapping scope, including missing indexes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mate-reference-writer-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  const old = new Store(path);
  old.register("research", "test", []);
  old.queueOutput("research", "old", {
    target: { channel: "CTEST", thread: "1.000001" },
    text: "legacy bytes",
  });
  old.transitionOutput("old", "pending", "sending");
  old.transitionOutput("old", "sending", "unknown", { reason: "lost reply" });
  const original = old.output("old");
  migrateLegacyReferences(old, "TTEST");
  old.close();
  const { s, output, c, refs } = setup(path);
  output.queue("research", { channel: "CTEST", thread: "1.000001" }, "same thread", "same");
  output.queue("research", { channel: "CTEST" }, "whole room", "room");
  output.queue(
    "research",
    { channel: "CTEST", thread: "2.000001" },
    "other thread",
    "other-thread",
  );
  output.queue("research", { channel: "CTWO" }, "elsewhere", "other-room");
  output.gate = new FreshnessGate(c.messages, c.attention);
  expect(output.ready().map((row) => row.id)).toEqual(["other-thread", "other-room"]);
  expect(s.output("old")).toEqual(original);
  const index = refs.indexedTarget("outbox", "old")!;
  s.db
    .prepare("DELETE FROM canonical_targets WHERE object_type='outbox' AND object_id='old'")
    .run();
  expect(() => output.ready()).toThrow("index missing");
  await expect(output.send("same")).rejects.toThrow("index missing");
  expect(s.output("same")?.state).toBe("pending");
  refs.indexTarget("outbox", "old", index);
  expect(output.ready().map((row) => row.id)).toEqual(["other-thread", "other-room"]);
});

it("rolls back authoritative objects and their reference writes together", () => {
  const { s, m, c, refs } = setup();
  const before = s.db.prepare("SELECT * FROM canonical_targets").all();
  expect(() =>
    s.atomic(() => {
      c.createWork("will-rollback", { channel: "CNEW", thread: "3.000001" });
      m.persistence.writes.queueOutput("research", "rolled-back", {
        target: { channel: "CNEW" },
        text: "body",
      });
      throw new Error("injected failure");
    }),
  ).toThrow("injected failure");
  expect(s.output("rolled-back")).toBeUndefined();
  expect(s.db.prepare("SELECT 1 FROM works WHERE origin='will-rollback'").get()).toBeUndefined();
  expect(
    refs.findConversation({
      provider: "slack",
      workspace: "TTEST",
      externalId: "CNEW",
    }),
  ).toBeUndefined();
  expect(s.db.prepare("SELECT * FROM canonical_targets").all()).toEqual(before);
  expect(() => m.persistence.writes.target("works", "no-authority", { channel: "CTEST" })).toThrow(
    "transaction",
  );
});

it("indexes the stored delivery on dedupe and keeps reminder edits aligned with eligibility", () => {
  const { s, m, c, refs } = setup();
  const one = m.persistence.writes.enqueue("research", "same", {
    target: { channel: "CTEST" },
  });
  expect(
    m.persistence.writes.enqueue("research", "same", {
      target: { channel: "CTWO" },
    }),
  ).toBe(one);
  expect(refs.indexedTarget("deliveries", one)).toEqual({
    conversationId: "CTEST",
  });
  const work = c.createWork("reminder", { channel: "CTEST" });
  const r = c.reminders.create("research", work, {
    target: { channel: "CTEST" },
    content: "Inspect",
    nextAt: Date.now() + 60000,
    timezone: "UTC",
  });
  c.reminders.edit("research", r.id, r.version, {
    target: { channel: "CTWO", thread: "4.000001" },
    content: "Inspect elsewhere",
    nextAt: Date.now() + 60000,
    timezone: "UTC",
  });
  expect(refs.indexedTarget("schedules", r.id)).toEqual({
    conversationId: "CTWO",
    threadId: encode(["TTEST", "CTWO", "4.000001"]),
  });
  m.membership("research", "CTWO", false);
  expect(c.reminders.list("research")).toEqual([]);
});

it("rejects internal projection targets through the temporary legacy writer", () => {
  const { s, m, refs } = setup();
  refs.createConversation("dm", "internal", "private-conversation");
  refs.bindConversation(
    { provider: "slack", workspace: "TTEST", externalId: "CPROJECTION" },
    "private-conversation",
    "projection",
  );
  expect(() =>
    m.persistence.writes.queueOutput("research", "not-a-projection", {
      target: { channel: "CPROJECTION" },
      text: "private",
    }),
  ).toThrow("Legacy writer requires");
  expect(s.output("not-a-projection")).toBeUndefined();
});

it("never signs a complete view when a sent publication index is missing or points elsewhere", () => {
  const { s, m, c, refs } = setup();
  m.persistence.writes.queueOutput("research", "artifact", {
    target: { channel: "CTEST" },
    text: "caption",
    artifact: { title: "report", content: "bytes", contentHash: "hash" },
  });
  s.transitionOutput("artifact", "pending", "sending");
  s.transitionOutput("artifact", "sending", "sent", { fileId: "FREPORT" });
  s.db
    .prepare(
      "INSERT INTO conversation_events(channel,thread,message_key,revision,kind) VALUES(?,?,?,?,?)",
    )
    .run("CTEST", "", "artifact:FREPORT", "FREPORT", "artifact");
  s.enqueue("research", "inspect", {});
  const run = s.beginRun("research")!;
  const target = { channel: "CTEST" };
  const original = refs.indexedTarget("outbox", "artifact")!;
  s.db
    .prepare("DELETE FROM canonical_targets WHERE object_type='outbox' AND object_id='artifact'")
    .run();
  expect(() => c.attention.read(run, target)).toThrow("index missing");
  refs.indexTarget("outbox", "artifact", { conversationId: "CTWO" });
  expect(() => c.attention.read(run, target)).toThrow("inconsistent");
  expect(s.db.prepare("SELECT count(*) n FROM attention_views").get()).toEqual({
    n: 0,
  });
  refs.indexTarget("outbox", "artifact", original);
  const first = c.attention.read(run, target) as { nextCursor: string };
  expect(first.nextCursor).toBeTruthy();
  expect(c.attention.read(run, target, first.nextCursor)).toMatchObject({
    publications: [{ fileId: "FREPORT" }],
  });
});
