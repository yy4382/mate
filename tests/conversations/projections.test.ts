import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../../src/storage/store.js";
import { localApplication } from "../../src/local/application.js";
import { migrateProjections } from "../../src/storage/projection-schema.js";
import {
  Projections,
  type ProjectionTransport,
  type ProjectionEvidence,
  type ProjectionDispatch,
} from "../../src/conversations/projections.js";
import type { ConversationTarget } from "../../src/domain/conversations.js";
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function setup() {
  const s = new Store(":memory:");
  stores.push(s);
  const settings = {
    agents: ["alice", "bob"].map((id) => ({
      id,
      name: id,
      role: "colleague",
      model: { provider: "test", id: "test", apiKeyEnv: "TEST_KEY" },
    })),
    ownerUserIds: ["owner"],
    runTimeoutMs: 10000,
  };
  const app = localApplication(s, settings);
  migrateProjections(s);
  for (const a of settings.agents) s.register(a.id, "test", []);
  const target = app.input.createRoom("local-room", ["alice", "bob"], ["owner"]);
  let n = 0;
  const evidence = (r: ProjectionDispatch): ProjectionEvidence => {
    const id = `remote-${++n}`;
    return {
      publisher: r.publisher,
      locator: { ...r.wire.target, messageId: id },
      root: r.wire.thread ?? id,
      text: r.wire.text,
    };
  };
  const post = vi.fn(async (r: ProjectionDispatch) => evidence(r)),
    authorized = vi.fn(async () => true);
  const transport: ProjectionTransport = {
    prepare: (b, text, thread) => ({
      text,
      target: { provider: b.provider, workspace: b.workspace, externalId: b.externalId },
      ...(thread ? { thread } : {}),
    }),
    authorized,
    post,
    classify: () => ({ kind: "unknown" }),
  };
  const p = new Projections(app.messages, new Map([["test", transport]]));
  const bind = (externalId = "display") =>
    p.configure(
      target.conversationId,
      { provider: "test", workspace: "test", externalId },
      "alice",
      [{ kind: "human", id: "owner" }],
      true,
    );
  const input = (id: string, t: ConversationTarget = target) =>
    app.input.receive("owner", id, t, `message ${id}`).messageId;
  const projection = (binding: string, message: string) =>
    p.get(
      (
        s.db
          .prepare("SELECT id FROM projection_outbox WHERE binding_id=? AND message_id=?")
          .get(binding, message) as { id: string }
      ).id,
    );
  return { s, ...app, p, target, post, transport, authorized, evidence, bind, input, projection };
}
it("projection failure leaves the canonical message and runnable recipient work committed", async () => {
  const f = setup(),
    b = f.bind(),
    message = f.input("first"),
    row = f.projection(b, message);
  f.post.mockRejectedValueOnce(new Error("lost connection"));
  await f.p.send(row.id);
  expect(f.p.get(row.id).state).toBe("unknown");
  expect(f.messages.message("bob", message).text).toBe("message first");
  expect(f.s.db.prepare("SELECT count(*) n FROM delivery_work").get()).toEqual({ n: 2 });
  await f.p.send(row.id);
  expect(f.post).toHaveBeenCalledOnce();
  const frozen = f.p.get(row.id);
  const restarted = new Projections(f.messages, new Map([["test", f.transport]]));
  restarted.recover();
  await restarted.send(row.id);
  expect(f.post).toHaveBeenCalledOnce();
  expect(restarted.get(row.id).wire).toBe(frozen.wire);
  expect(restarted.get(row.id).request_hash).toBe(frozen.request_hash);
});
it("echo before HTTP shares one atomic confirmation, rejects forged evidence and never adds delivery", async () => {
  const f = setup(),
    b = f.bind(),
    message = f.input("echo"),
    row = f.projection(b, message);
  const count = f.s.db.prepare("SELECT count(*) n FROM deliveries").get();
  let accepted: ProjectionEvidence | undefined,
    hash = "";
  f.post.mockImplementationOnce(async (r) => {
    accepted = f.evidence(r);
    hash = r.requestHash;
    for (const change of [{ publisher: "bob" }, { root: "wrong-root" }, { text: "changed" }])
      expect(() => f.p.confirm(r.id, r.requestHash, { ...accepted!, ...change })).toThrow(
        "mismatch",
      );
    f.p.confirm(r.id, r.requestHash, accepted);
    throw new Error("HTTP lost after echo");
  });
  await f.p.send(row.id);
  expect(f.p.get(row.id).state).toBe("sent");
  f.p.confirm(row.id, hash, accepted!);
  expect(f.s.db.prepare("SELECT count(*) n FROM deliveries").get()).toEqual(count);
  expect(f.messages.references.findMessage(accepted!.locator)).toBe(message);
  expect(() => f.p.confirm(row.id, "forged", accepted!)).toThrow("hash");
  const fresh = f.projection(b, f.input("unpublished"));
  expect(() => f.p.confirm(fresh.id, hash, accepted!)).toThrow("not dispatched");
});
it("holds old roots without leaking history, then an explicitly authorized blank anchor unblocks reply", async () => {
  const f = setup(),
    old = f.input("private-old"),
    b = f.bind(),
    reply = f.input("reply", { ...f.target, threadId: old }),
    row = f.projection(b, reply);
  await f.p.send(row.id);
  expect(f.p.get(row.id)).toMatchObject({ state: "held", reason: "missing_historical_root" });
  expect(f.post).not.toHaveBeenCalled();
  const anchor = f.p.anchor(b, old);
  await f.p.send(anchor);
  expect(f.post.mock.calls[0]![0].wire.text).not.toContain("private-old");
  await f.p.send(row.id);
  expect(f.p.get(row.id).state).toBe("sent");
  expect(f.post.mock.calls[1]![0].wire.thread).toBe(JSON.parse(f.p.get(anchor).receipt!).messageId);
});
it("keeps delayed roots, unknown predecessors and independent bindings distinct", async () => {
  const f = setup(),
    a = f.bind("one"),
    b = f.bind("two"),
    root = f.input("root"),
    reply = f.input("reply", { ...f.target, threadId: root });
  const r = f.projection(a, reply);
  await f.p.send(r.id);
  expect(f.p.get(r.id).reason).toBe("waiting_root_receipt");
  f.post.mockRejectedValueOnce(new Error("uncertain"));
  await f.p.send(f.projection(a, root).id);
  await f.p.send(r.id);
  expect(f.p.get(r.id).reason).toBe("root_unknown");
  await f.p.send(f.projection(b, root).id);
  await f.p.send(f.projection(b, reply).id);
  expect(f.projection(b, reply).state).toBe("sent");
});
it("rechecks disable and publisher permission after asynchronous authorization", async () => {
  const f = setup(),
    b = f.bind(),
    message = f.input("pending"),
    row = f.projection(b, message);
  f.authorized.mockImplementationOnce(async () => {
    f.p.setEnabled(b, false);
    return true;
  });
  await f.p.send(row.id);
  expect(f.p.get(row.id).reason).toBe("binding_disabled");
  expect(f.post).not.toHaveBeenCalled();
  f.p.setEnabled(b, true);
  f.messages.membership("alice", f.target.conversationId, false);
  await f.p.send(row.id);
  expect(f.p.get(row.id).reason).toBe("publisher_access_revoked");
});
it("never sends a stale unsent snapshot after the canonical source changes", async () => {
  const f = setup(),
    b = f.bind(),
    id = f.input("editable"),
    row = f.projection(b, id),
    message = f.messages.message("alice", id);
  f.messages.record({ ...message, revision: "999", text: "newer content" }, ["alice", "bob"]);
  await f.p.send(row.id);
  expect(f.p.get(row.id)).toMatchObject({
    state: "failed",
    reason: "source_changed_before_publication",
  });
  expect(f.post).not.toHaveBeenCalled();
  expect(f.messages.message("bob", id).text).toBe("newer content");
});
it("binding authorization is explicit, unique and scoped to internal membership", () => {
  const f = setup(),
    locator = { provider: "test", workspace: "test", externalId: "display" };
  expect(() => f.p.configure(f.target.conversationId, locator, "alice", [], false)).toThrow(
    "disclosure",
  );
  expect(() =>
    f.p.configure(
      f.target.conversationId,
      locator,
      "alice",
      [{ kind: "human", id: "outsider" }],
      true,
    ),
  ).toThrow("not an internal member");
  f.bind();
  f.messages.references.createConversation("channel", "internal", "other");
  f.messages.membership("alice", "other", true);
  expect(() => f.p.configure("other", locator, "alice", [], true)).toThrow("already bound");
  expect(() =>
    new Projections(f.messages, new Map()).configure(
      f.target.conversationId,
      { ...locator, externalId: "new" },
      "alice",
      [],
      true,
    ),
  ).toThrow("adapter unavailable");
});
it("published mirrors track source drift without overwriting canonical content or replaying a send", async () => {
  const f = setup(),
    b = f.bind(),
    id = f.input("source"),
    row = f.projection(b, id);
  await f.p.send(row.id);
  const m = f.messages.message("alice", id);
  f.messages.record({ ...m, revision: "100", deleted: true, text: "" }, ["alice", "bob"]);
  expect(f.p.get(row.id)).toMatchObject({ state: "sent", drift: "source_changed" });
  await f.p.send(row.id);
  expect(f.post).toHaveBeenCalledOnce();
  expect(() =>
    f.s.db.prepare("UPDATE projection_bindings SET publisher='bob' WHERE id=?").run(b),
  ).toThrow("immutable");
  expect(() =>
    f.s.db.prepare("UPDATE projection_outbox SET text='replacement' WHERE id=?").run(row.id),
  ).toThrow("immutable");
  expect(() =>
    f.s.db.prepare("UPDATE projection_outbox SET wire='{}' WHERE id=?").run(row.id),
  ).toThrow("immutable");
});

it("reopens a real database with unknown frozen evidence and reconciles without sending again", async () => {
  const f = setup(),
    b = f.bind(),
    message = f.input("persist"),
    row = f.projection(b, message);
  f.post.mockRejectedValueOnce(new Error("unknown"));
  await f.p.send(row.id);
  const before = f.p.get(row.id);
  const dir = mkdtempSync(join(tmpdir(), "mate-projection-")),
    path = join(dir, "state.sqlite");
  try {
    await f.s.db.backup(path);
    f.s.close();
    stores.splice(stores.indexOf(f.s), 1);
    const s = new Store(path);
    try {
      const app = localApplication(s, f.collaboration.config),
        p = new Projections(app.messages, new Map([["test", f.transport]]));
      p.recover();
      await p.send(row.id);
      expect(f.post).toHaveBeenCalledOnce();
      expect(p.get(row.id)).toEqual(before);
      const request = f.post.mock.calls[0]![0];
      p.confirm(row.id, request.requestHash, f.evidence(request));
      expect(p.get(row.id).state).toBe("sent");
      expect(s.db.prepare("SELECT count(*) n FROM messages").get()).toEqual({ n: 1 });
      expect(s.db.prepare("SELECT count(*) n FROM delivery_work").get()).toEqual({ n: 2 });
    } finally {
      s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
