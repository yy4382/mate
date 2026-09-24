import { afterEach, expect, it } from "vitest";
import { Store } from "../../src/storage/store.js";
import { References } from "../../src/conversations/references.js";
import { CanonicalWrites } from "../../src/storage/conversation-writes.js";
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
it("persists explicit v2 requests and does not let callers choose envelope versions", () => {
  const s = new Store(":memory:");
  stores.push(s);
  s.register("research", "test", []);
  const refs = new References(s),
    writes = new CanonicalWrites(s, refs);
  refs.createConversation("channel", "external", "opaque-space");
  const row = writes.queueOutput("research", "new", {
    target: { conversationId: "opaque-space" },
    text: "body",
  });
  expect(JSON.parse(row.request)).toEqual({
    format: "mate.effect.v2",
    target: { conversationId: "opaque-space" },
    text: "body",
  });
  expect(() =>
    writes.queueOutput("research", "bad", {
      format: "mate.effect.v1",
      target: { conversationId: "opaque-space" },
      text: "body",
    }),
  ).toThrow("controlled by persistence");
  expect(s.output("bad")).toBeUndefined();
});
