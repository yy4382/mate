import { afterEach, expect, it } from "vitest";
import { Store, encode } from "../../src/storage/store.js";
import { compareMessageOrder } from "../../src/domain/messages.js";
import type { MessageDTO } from "../../src/domain/messages.js";
import { Messages, fixtureTarget } from "../helpers/canonical-slack.js";
import { configFixture } from "../helpers/config.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function setup() {
  const s = new Store(":memory:");
  stores.push(s);
  s.register("research", "v1", []);
  const messages = new Messages(s, configFixture);
  messages.membership("research", "CTEST", true);
  return { s, messages, records: messages.records };
}
const original: MessageDTO = {
  id: "message",
  conversationId: "CTEST",
  rootId: "message",
  author: { kind: "human", id: "owner" },
  origin: "participant",
  mentions: [],
  text: "Hello <@UONE> <@UOWNER> <@UONE>",
  deleted: false,
  order: "9999999999999999999999",
  revision: "9999999999999999999999",
  attachments: [],
};

it("stores precise order, participant identity, mentions and origin without changing stored content", () => {
  const { s, messages, records } = setup();
  messages.record({ ...original, origin: "system" }, []);
  const before = s.db.prepare("SELECT * FROM messages").get();
  expect(records.message("message")).toEqual({ ...original, origin: "system" });
  expect(s.db.prepare("SELECT * FROM messages").get()).toEqual(before);
  expect(records.message("missing")).toBeUndefined();
});

it("hides deleted text and mentions while keeping the stored tombstone readable", () => {
  const { messages, records } = setup();
  messages.record({ ...original, deleted: true, text: "" }, []);
  expect(records.message("message")).toMatchObject({
    rootId: "message",
    deleted: true,
    text: "",
    mentions: [],
  });
});

it("fails closed on a stored body whose identity no longer matches its reference", () => {
  const { s, messages, records } = setup();
  messages.record(original, []);
  messages.references.createMessage("CTEST", "other");
  s.db.prepare("UPDATE messages SET body=? WHERE key=?").run(
    encode({
      format: "mate.message.v2",
      message: { ...original, id: "other", rootId: "other" },
    }),
    "message",
  );
  expect(() => records.message("message")).toThrow("identity mismatch");
});

it("compares canonical order numerically without precision loss or ambiguous encodings", () => {
  expect(compareMessageOrder("9", "10")).toBe(-1);
  expect(compareMessageOrder("9999999999999999999999", "9999999999999999999998")).toBe(1);
  expect(compareMessageOrder("0", "0")).toBe(0);
  for (const invalid of ["01", "-1", "1.0", "1e3", ""])
    expect(() => compareMessageOrder(invalid, "0")).toThrow();
});

it("reads the stored conversation target of an immutable unknown output without rewriting it", () => {
  const { s, records } = setup();
  const target = fixtureTarget();
  s.queueOutput(
    "research",
    "output",
    { format: "mate.effect.v2", target, text: "frozen" },
    JSON.stringify(target),
  );
  s.transitionOutput("output", "pending", "sending");
  s.transitionOutput("output", "sending", "unknown", { reason: "timeout" });
  const old = s.output("output")!;
  expect(records.targetedEffect("outbox", "output")).toEqual({
    id: "output",
    actor: "research",
    state: "unknown",
    target,
    original: { request: old.request, requestHash: old.request_hash, receipt: old.receipt },
  });
  expect(s.output("output")).toEqual(old);
});

it("keeps a stored output routing target immutable once written", () => {
  const { s, records } = setup();
  const target = fixtureTarget();
  s.queueOutput(
    "research",
    "output",
    { format: "mate.effect.v2", target, text: "frozen" },
    JSON.stringify(target),
  );
  expect(() =>
    s.db
      .prepare("UPDATE outbox SET target=? WHERE id='output'")
      .run(JSON.stringify({ conversationId: "CTEST" })),
  ).toThrow("immutable");
  expect(records.targetedEffect("outbox", "output").target).toEqual(target);
});

it("rejects an effect without a conversation target", () => {
  const { s, records } = setup();
  s.enqueue("research", "trigger", {});
  const run = s.beginRun("research")!;
  s.input(run, {});
  s.prepareAction(run, "indirect", { operation: "task.read", args: { taskId: "some-task" } });
  expect(() => records.targetedEffect("actions", "indirect")).toThrow("no conversation target");
});

it("reads a mutable object target from the authoritative row", () => {
  const { s, records } = setup();
  const target = fixtureTarget();
  s.db
    .prepare("INSERT INTO works(id,origin,target,state) VALUES(?,?,?,'active')")
    .run("work", "source", encode(target));
  const before = s.db.prepare("SELECT * FROM works").all();
  expect(records.mutableTarget("works", "work")).toEqual(target);
  expect(s.db.prepare("SELECT * FROM works").all()).toEqual(before);
  expect(() => records.mutableTarget("works", "absent")).toThrow("object missing");
});
