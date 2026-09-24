import { afterEach, expect, it } from "vitest";
import { Store, encode } from "../../src/storage/store.js";
import { Messages, Output, fixtureTarget } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { CanonicalFreshnessGate } from "../../src/conversations/freshness.js";
import { configFixture } from "../helpers/config.js";

const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function setup() {
  const s = new Store(":memory:");
  cleanup.push(() => s.close());
  s.register("research", "v1", []);
  const m = new Messages(s, configFixture),
    output = new Output(m, { post: async () => ({ ts: "50.000001" }) });
  const c = new Collaboration(s, m, output, configFixture);
  m.membership("research", "CTEST", true);
  m.membership("research", "CTWO", true);
  return { s, m, output, c };
}
it("keeps an unknown output's frozen wire evidence and holds overlapping scopes behind it", () => {
  const { s, m, c, output } = setup();
  output.queue("research", { conversationId: "CTEST" }, "first wire", "old");
  s.transitionOutput("old", "pending", "sending");
  s.transitionOutput("old", "sending", "unknown", { reason: "lost reply" });
  const before = s.output("old")!;
  output.gate = new CanonicalFreshnessGate(m, c.attention);
  const otherThread = m.mapper.messageId("CTEST", "100.000002");
  m.references.createMessage("CTEST", otherThread);
  output.queue("research", { conversationId: "CTEST" }, "whole room", "room");
  output.queue("research", { conversationId: "CTEST", threadId: otherThread }, "elsewhere", "ok");
  expect(output.ready()).toEqual([]);
  expect(s.output("room")?.state).toBe("held");
  expect(s.output("ok")?.state).toBe("held");
  expect(
    c.output.gate!.list("research").map((draft) => (draft as { draftId: string }).draftId),
  ).toEqual(["ok", "room"]);
  expect(s.output("old")).toEqual(before);
  expect(before.receipt).toContain("lost reply");
});

it("rolls authoritative objects and their reference writes back together", () => {
  const { s, m, c } = setup();
  const before = s.db.prepare("SELECT * FROM works").all();
  expect(() =>
    s.atomic(() => {
      c.createWork("will-rollback", fixtureTarget());
      m.writes.queueOutput("research", "rolled-back", {
        target: { conversationId: "CTEST" },
        text: "body",
      });
      throw new Error("injected failure");
    }),
  ).toThrow("injected failure");
  expect(s.output("rolled-back")).toBeUndefined();
  expect(s.db.prepare("SELECT 1 FROM works WHERE origin='will-rollback'").get()).toBeUndefined();
  expect(s.db.prepare("SELECT * FROM works").all()).toEqual(before);
});

it("dedupes a stored delivery and keeps reminder edits aligned with eligibility", () => {
  const { s, m, c } = setup();
  const one = m.writes.enqueue("research", "same", { target: fixtureTarget() });
  expect(m.writes.enqueue("research", "same", { target: fixtureTarget() })).toBe(one);
  expect(JSON.parse(s.delivery(one).payload).target).toEqual(fixtureTarget());
  const work = c.createWork("reminder", fixtureTarget());
  const r = c.reminders.create("research", work, {
    target: fixtureTarget(),
    content: "Inspect",
    nextAt: Date.now() + 60000,
    timezone: "UTC",
  });
  c.reminders.edit("research", r.id, r.version, {
    target: fixtureTarget(),
    content: "Inspect elsewhere",
    nextAt: Date.now() + 60000,
    timezone: "UTC",
  });
  expect(c.reminders.list("research").map((reminder) => reminder.content)).toEqual([
    "Inspect elsewhere",
  ]);
  m.membership("research", "CTEST", false);
  expect(c.reminders.list("research")).toEqual([]);
});
