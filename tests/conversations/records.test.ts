import { afterEach, expect, it } from "vitest";
import { Store, encode } from "../../src/storage/store.js";
import { ConversationRecords } from "../../src/storage/conversations.js";
import { compareMessageOrder } from "../../src/domain/messages.js";
import { References } from "../../src/conversations/references.js";
import { LegacyConversationCodec } from "../../src/slack/legacy-codec.js";
import { migrateLegacyReferences } from "../../src/slack/reference-migration.js";
import { Messages } from "../fixtures/v16/src/slack/messages.js";
import { configFixture } from "../helpers/config.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function setup() {
  const s = new Store(":memory:");
  stores.push(s);
  s.register("research", "legacy", []);
  const refs = new References(s),
    codec = new LegacyConversationCodec(refs, configFixture);
  const records = new ConversationRecords(s, refs, codec),
    messages = new Messages(s, configFixture);
  return { s, refs, codec, records, messages };
}
const original = {
  team: "TTEST",
  channel: "CTEST",
  ts: "9999999999999999.999999",
  thread: "9999999999999999.999999",
  revision: "9999999999999999.999999",
  text: "Hello <@UONE> <@UOWNER> <@UONE>",
  user: "UONE",
  bot: "BONE",
  deleted: false,
};
const id = encode(["TTEST", "CTEST", original.ts]);

it("decodes precise order, participant identity, mentions and system origin without changing stored content", () => {
  const { s, records, messages } = setup();
  messages.record(
    {
      ...original,
      systemGenerated: true,
      files: [{ id: "FONE", name: "empty", size: 0 }, { id: "FTWO" }],
    },
    [],
  );
  const before = s.db.prepare("SELECT * FROM messages").get();
  migrateLegacyReferences(s, "TTEST");
  expect(records.message(id)).toEqual({
    id,
    conversationId: "CTEST",
    rootId: id,
    author: { kind: "agent", id: "research" },
    origin: "system",
    mentions: [
      { kind: "agent", id: "research" },
      { kind: "human", id: encode(["slack", "TTEST", "user", "UOWNER"]) },
    ],
    text: original.text,
    deleted: false,
    order: "9999999999999999999999",
    revision: "9999999999999999999999",
    attachments: [{ id: "FONE", name: "empty", size: 0 }, { id: "FTWO" }],
  });
  expect(s.db.prepare("SELECT * FROM messages").get()).toEqual(before);
  expect(records.message("missing")).toBeUndefined();
});

it("keeps an unresolved tombstone location and hides deleted text and mentions", () => {
  const { records, messages, s } = setup();
  messages.record({ ...original, deleted: true }, []);
  migrateLegacyReferences(s, "TTEST");
  expect(records.message(id)).toMatchObject({
    rootId: null,
    deleted: true,
    text: "",
    mentions: [],
  });
});

it("fails closed on missing mappings, a mismatched message body and target index drift", () => {
  const { s, refs, records, messages, codec } = setup();
  messages.record(original, []);
  s.db.exec(
    "DELETE FROM message_bindings; DELETE FROM message_identities; DELETE FROM conversation_bindings; DELETE FROM conversation_identities",
  );
  expect(() => records.message(id)).toThrow("mapping missing");
  expect(() => codec.target({ channel: "CTEST" })).toThrow("mapping missing");
  migrateLegacyReferences(s, "TTEST");
  messages.record({ ...original, ts: "1.000001", thread: "1.000001", revision: "1.000001" }, []);
  migrateLegacyReferences(s, "TTEST");
  s.db
    .prepare("UPDATE messages SET body=? WHERE key=?")
    .run(encode({ ...original, ts: "1.000001", thread: "1.000001", revision: "1.000001" }), id);
  expect(() => records.message(id)).toThrow("identity mismatch");
  s.queueOutput("research", "output", { target: { channel: "CTEST" }, text: "body" });
  expect(() => records.targetedEffect("outbox", "output")).toThrow("index missing");
  migrateLegacyReferences(s, "TTEST");
  refs.indexTarget("outbox", "output", { conversationId: "CTEST", threadId: id });
  expect(() => records.targetedEffect("outbox", "output")).toThrow("inconsistent");
});

it("separates canonical target from immutable unknown wire evidence and rejects untargeted actions", () => {
  const { s, records } = setup();
  s.queueOutput("research", "output", {
    target: { channel: "CTEST", thread: "1.000001" },
    text: "frozen",
  });
  s.transitionOutput("output", "pending", "sending");
  s.transitionOutput("output", "sending", "unknown", { reason: "timeout" });
  s.enqueue("research", "trigger", {});
  const run = s.beginRun("research")!;
  s.prepareAction(run, "targeted", { args: { target: { channel: "CTEST" } } });
  s.prepareAction(run, "indirect", { operation: "task.read", args: { taskId: "some-task" } });
  const old = s.output("output")!;
  migrateLegacyReferences(s, "TTEST");
  expect(records.targetedEffect("outbox", "output")).toEqual({
    id: "output",
    actor: "research",
    state: "unknown",
    target: { conversationId: "CTEST", threadId: encode(["TTEST", "CTEST", "1.000001"]) },
    original: { request: old.request, requestHash: old.request_hash, receipt: old.receipt },
  });
  expect(records.targetedEffect("actions", "targeted").target).toEqual({ conversationId: "CTEST" });
  expect(() => records.targetedEffect("actions", "indirect")).toThrow("no conversation target");
  expect(s.output("output")).toEqual(old);
});

it("compares canonical order numerically without precision loss or ambiguous encodings", () => {
  expect(compareMessageOrder("9", "10")).toBe(-1);
  expect(compareMessageOrder("9999999999999999999999", "9999999999999999999998")).toBe(1);
  expect(compareMessageOrder("0", "0")).toBe(0);
  for (const invalid of ["01", "-1", "1.0", "1e3", ""])
    expect(() => compareMessageOrder(invalid, "0")).toThrow();
});

it("rejects contradictory author evidence independently of configuration order", () => {
  const { s, refs, messages } = setup();
  messages.record(original, []);
  migrateLegacyReferences(s, "TTEST");
  const one = configFixture.agents[0]!;
  const two = { ...one, id: "writer", slackUserId: "UTWO", slackBotId: "BTWO" };
  for (const agents of [
    [one, two],
    [two, one],
  ]) {
    const codec = new LegacyConversationCodec(refs, { ...configFixture, agents });
    for (const author of [
      { user: "UONE", bot: "BTWO" },
      { user: "UOTHER", bot: "BONE" },
      { user: "UONE", bot: "BOTHER" },
    ]) {
      expect(() => codec.message(encode({ ...original, ...author }))).toThrow(
        "Conflicting legacy author",
      );
    }
    const { user: _user, bot: _bot, ...anonymous } = original;
    expect(codec.message(encode(anonymous)).author).toEqual({ kind: "unknown" });
    expect(codec.message(encode({ ...anonymous, bot: "BONE" })).author).toEqual({
      kind: "agent",
      id: "research",
    });
  }
});

it("reads mutable targets without writes and rejects absent or drifting derived indexes", () => {
  const { s, refs, records } = setup();
  s.db
    .prepare("INSERT INTO works(id,origin,target,max_runs,max_tokens,max_cost) VALUES(?,?,?,?,?,?)")
    .run("work", "source", encode({ channel: "CTEST", thread: "1.000001" }), 10, 1000, 1);
  migrateLegacyReferences(s, "TTEST");
  const before = s.db.prepare("SELECT * FROM works").all();
  const indexes = s.db.prepare("SELECT * FROM canonical_targets").all();
  expect(records.mutableTarget("works", "work")).toEqual({
    conversationId: "CTEST",
    threadId: encode(["TTEST", "CTEST", "1.000001"]),
  });
  expect(s.db.prepare("SELECT * FROM works").all()).toEqual(before);
  expect(s.db.prepare("SELECT * FROM canonical_targets").all()).toEqual(indexes);
  expect(() => records.mutableTarget("works", "absent")).toThrow("object missing");
  s.db.prepare("DELETE FROM canonical_targets WHERE object_type='works'").run();
  expect(() => records.mutableTarget("works", "work")).toThrow("index missing");
  refs.indexTarget("works", "work", { conversationId: "CTEST" });
  expect(() => records.mutableTarget("works", "work")).toThrow("inconsistent");
});
