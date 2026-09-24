import { afterEach, expect, it } from "vitest";
import { Store } from "../../src/storage/store.js";
import { References } from "../../src/conversations/references.js";

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((clean) => clean()),
);
function setup() {
  const s = new Store(":memory:");
  cleanups.push(() => s.close());
  return { s, r: new References(s) };
}

it("keeps opaque identities, authority and projection routing independent of provider IDs", () => {
  const { s, r } = setup();
  const dm = r.createConversation("dm", "internal");
  const channel = r.createConversation("channel", "external");
  const root = r.createMessage(dm.id);
  const reply = r.createMessage(dm.id, "another-message", root.id);
  expect(reply.rootId).toBe(root.id);
  expect(r.validateTarget({ conversationId: dm.id, threadId: root.id })).toBeDefined();
  expect(() => r.validateTarget({ conversationId: channel.id, threadId: root.id })).toThrow(
    "Invalid target",
  );
  expect(() => r.validateTarget({ conversationId: dm.id, threadId: reply.id })).toThrow(
    "Invalid target",
  );
  const locator = { provider: "example", workspace: "personal", externalId: "space-9" };
  r.bindConversation(locator, dm.id, "projection");
  expect(() => r.bindConversation(locator, channel.id, "primary")).toThrow("already bound");
  expect(() => r.bindConversation({ ...locator, externalId: "other" }, dm.id, "primary")).toThrow(
    "authority",
  );
  expect(() => r.createConversation("channel", "external", dm.id)).toThrow("identity conflict");
  expect(s.db.prepare("SELECT count(*) n FROM channel_access").get()).toEqual({ n: 0 });
  expect(s.db.prepare("SELECT count(*) n FROM messages").get()).toEqual({ n: 0 });
});

it("rejects cross-conversation message bindings and preserves globally distinct same-local-ID messages", () => {
  const { r } = setup();
  const a = r.createConversation("channel", "external", "old-channel");
  const b = r.createConversation("channel", "external");
  const la = { provider: "example", workspace: "one", externalId: "a", messageId: "100" };
  const lb = { ...la, externalId: "b" };
  r.bindConversation(la, a.id, "primary");
  r.bindConversation(lb, b.id, "primary");
  const ma = r.createMessage(a.id),
    mb = r.createMessage(b.id);
  r.bindMessage(la, ma.id);
  r.bindMessage(lb, mb.id);
  expect(r.findMessage(la)).not.toBe(r.findMessage(lb));
  expect(() => r.bindMessage(la, mb.id)).toThrow("mismatch");
  const other = r.createMessage(a.id);
  expect(() => r.bindMessage(la, other.id)).toThrow("already bound");
});

it("reserves unknown message locations without assuming they are roots, then enriches from evidence", () => {
  const { r } = setup();
  const c = r.createConversation("channel", "internal");
  const unknown = r.reserveMessage(c.id, "not-loaded");
  expect(unknown.rootId).toBeNull();
  expect(() => r.validateTarget({ conversationId: c.id, threadId: unknown.id })).toThrow(
    "Invalid target",
  );
  const root = r.createMessage(c.id, "known-root");
  expect(r.createMessage(c.id, unknown.id, root.id).rootId).toBe(root.id);
  expect(() => r.createMessage(c.id, unknown.id, unknown.id)).toThrow("conflict");
});
