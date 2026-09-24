import { afterEach, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { Daemon } from "../../src/daemon/app.js";
import { LocalConsole } from "../../src/local/console.js";
import { acquireLock } from "../../src/daemon/lock.js";
import { storedConfiguration } from "../../src/daemon/config.js";
import { Store } from "../../src/storage/store.js";
import { TeamDirectory } from "../../src/conversations/team-directory.js";
import { daemonFixture } from "../helpers/daemon-config.js";
const clean: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of clean.splice(0).reverse()) await fn();
});
function config() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-local-runtime-")));
  clean.push(() => rmSync(root, { recursive: true, force: true }));
  const c = daemonFixture(join(root, "data"));
  c.mate.agents[0]!.model.id = "claude-haiku-4-5";
  c.mate.ownerUserIds = ["owner"];
  c.adapters = {
    local: {
      humans: ["owner", "reader"],
      rooms: [{ id: "local-room", agents: ["research"], humans: ["owner", "reader"] }],
    },
  };
  return { c, root };
}
async function daemon(c: unknown) {
  const d = await Daemon.create(c, { info: () => {}, error: () => {} });
  clean.push(() => d.close());
  return d;
}
it("keeps an Agent-owned workspace layout across daemon restarts", async () => {
  const { c } = config(),
    first = await daemon(c),
    home = first.memoryRoots.research!;
  await first.close();
  rmSync(join(home, "notes"), { recursive: true });
  rmSync(join(home, "artifacts"), { recursive: true });
  const second = await daemon(c);
  expect(second.memoryRoots.research).toBe(home);
  expect(existsSync(join(home, "MEMORY.md"))).toBe(true);
  expect(existsSync(join(home, "notes"))).toBe(false);
  expect(existsSync(join(home, "artifacts"))).toBe(false);
});
it("accepts an unused review workspace without optional starter directories", async () => {
  const { c } = config(),
    d = await daemon(c),
    home = d.memoryRoots.research!;
  rmSync(join(home, "notes"), { recursive: true });
  rmSync(join(home, "artifacts"), { recursive: true });
  expect(
    d.controls.execute(
      "owner",
      "review-seat research " +
        JSON.stringify({ target: { conversationId: "local-room" }, brief: "Review the proposal" }),
    ),
  ).toContain("enabled");
});
function credentials() {
  const previous = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY = "synthetic";
  clean.push(() => {
    if (previous === undefined) delete process.env.MODEL_API_KEY;
    else process.env.MODEL_API_KEY = previous;
  });
}
it("uses the same permanent daemon, Supervisor, tool/gate and local console without Slack credentials", async () => {
  credentials();
  const { c } = config(),
    d = await daemon(c),
    console = new LocalConsole(d.local!, d.controls);
  vi.spyOn(d.supervisor, "recovery").mockResolvedValue("synthetic private recovery");
  let calls = 0;
  vi.spyOn(d.supervisor, "factory").mockImplementation(() => ({
    close() {},
    async run(_spec, hooks) {
      calls++;
      if (calls === 1) {
        const draft = (
          await hooks.tool("reply", "messages.send", {
            target: { conversationId: "local-room" },
            text: "internal answer",
          })
        ).value as any;
        await hooks.tool("confirm", "drafts.continue", {
          draftId: draft.draftId,
          revision: draft.revision,
          holdId: draft.holdId,
          acknowledge: "send_despite_unread_or_changes",
        });
      }
      return { tokens: 3, cost: 0, certain: true, waiting: false, continuation: false };
    },
  }));
  d.collaboration.messages.watch("research", { conversationId: "local-room" }, true);
  await console.execute({
    id: "send",
    op: "send",
    human: "owner",
    eventId: "input-1",
    target: { conversationId: "local-room" },
    text: "investigate",
  });
  await d.start();
  await vi.waitFor(
    () =>
      expect(
        d
          .local!.read("owner", { conversationId: "local-room" })
          .messages.some((m) => m.text === "internal answer"),
      ).toBe(true),
    { timeout: 3000 },
  );
  expect(calls).toBeGreaterThan(0);
  expect(d.adapter).toBeUndefined();
  await expect(
    console.execute({ id: "bad", op: "control", human: "reader", text: "agent-stop research" }),
  ).rejects.toThrow("Owner only");
  await console.execute({
    id: "stop",
    op: "control",
    human: "owner",
    text: "agent-stop research",
  });
  await d.close();
  const reopened = await daemon(c);
  expect(
    reopened.local!.read("reader", { conversationId: "local-room" }).messages.map((m) => m.text),
  ).toContain("internal answer");
  expect(reopened.store.db.prepare("SELECT paused FROM agents WHERE id='research'").get()).toEqual({
    paused: 1,
  });
});
it("reports the local development home even without a shared Linux work root", async () => {
  const { c } = config(),
    d = await daemon(c),
    work = d.collaboration.createWork("environment", { conversationId: "local-room" });
  d.collaboration.enqueue("research", work, "read-environment", {});
  const run = d.store.beginRun("research")!;
  d.store.input(run, {});
  const result = await d.supervisor.router.call(
    run,
    work,
    "environment-info",
    "environment.info",
    {},
    new AbortController().signal,
  );
  expect(result.value).toMatchObject({
    filesystem: { home: d.memoryRoots.research, access: "local_user_permissions" },
  });
  expect((result.value as { filesystem: Record<string, unknown> }).filesystem).not.toHaveProperty(
    "sharedRoot",
  );
});
it("keeps room revocations across restart and configuration change, applying only explicit membership deltas", async () => {
  const { c, root } = config(),
    d = await daemon(c);
  d.local!.receive("owner", "input", { conversationId: "local-room" }, "durable");
  d.collaboration.messages.membership("research", "local-room", false);
  d.store.db
    .prepare(
      "DELETE FROM internal_members WHERE conversation_id='local-room' AND kind='human' AND principal_id='reader'",
    )
    .run();
  await d.close();
  const reopened = await daemon(c);
  expect(reopened.collaboration.messages.access("research", "local-room")).toBe(false);
  expect(() => reopened.local!.read("reader", { conversationId: "local-room" })).toThrow(
    "access denied",
  );
  await reopened.close();
  const next = structuredClone(c);
  next.mate.agents.push({ ...next.mate.agents[0]!, id: "peer" });
  next.adapters.local!.rooms[0]!.agents.push("peer");
  const migrated = await daemon(next);
  expect(migrated.collaboration.messages.access("research", "local-room")).toBe(false);
  expect(migrated.collaboration.messages.access("peer", "local-room")).toBe(true);
  expect(() => migrated.local!.read("reader", { conversationId: "local-room" })).toThrow(
    "access denied",
  );
  expect(migrated.local!.read("owner", { conversationId: "local-room" }).messages[0]!.text).toBe(
    "durable",
  );
});
it("refuses an older database through the daemon entry without changing the file", async () => {
  credentials();
  const { c } = config(),
    state = join(c.runtime.dataDir, "state");
  mkdirSync(state, { recursive: true });
  const path = join(state, "mate.sqlite"),
    legacy = new Database(path);
  legacy.exec(
    "CREATE TABLE agents(id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE); INSERT INTO agents VALUES('research','s'); PRAGMA user_version=16;",
  );
  legacy.close();
  const before = readFileSync(path);
  await expect(Daemon.create(c, { info: () => {}, error: () => {} })).rejects.toThrow(
    /is not a Mate first-release database|uses Mate schema revision/,
  );
  expect(readFileSync(path)).toEqual(before);
});
it("keeps identity, session, deliveries, tasks and reminders across a restart in the same format", async () => {
  credentials();
  const { c } = config(),
    d = await daemon(c),
    target = { conversationId: "local-room" },
    agent = d.collaboration.agents.get("research"),
    session = (
      d.store.db.prepare("SELECT session_id FROM agents WHERE id='research'").get() as {
        session_id: string;
      }
    ).session_id,
    work = d.collaboration.createWork("keep-work", target),
    delivery = d.collaboration.enqueue("research", work, "pending work", { text: "keep" }),
    task = d.collaboration.createTask("research", work, target, "keep this task"),
    reminder = d.collaboration.reminders.create("research", work, {
      target,
      content: "keep this reminder",
      nextAt: Date.now() + 600000,
      timezone: "UTC",
    });
  await d.close();
  const reopened = await daemon(c);
  expect(reopened.collaboration.agents.get("research")).toEqual(agent);
  expect(
    reopened.store.db.prepare("SELECT session_id FROM agents WHERE id='research'").get(),
  ).toEqual({ session_id: session });
  expect(
    reopened.store.db.prepare("SELECT status FROM deliveries WHERE id=?").get(delivery),
  ).toEqual({ status: "pending" });
  expect(
    reopened.store.db
      .prepare("SELECT work_id FROM delivery_work WHERE delivery_id=?")
      .get(delivery),
  ).toEqual({ work_id: work });
  expect(reopened.store.db.prepare("SELECT title,status FROM tasks WHERE id=?").get(task)).toEqual({
    title: "keep this task",
    status: "todo",
  });
  expect(reopened.collaboration.reminders.list("research").map((row) => row.id)).toEqual([
    reminder.id,
  ]);
});
it("fires a reminder that came due across a restart for its author and its work item", async () => {
  credentials();
  const { c } = config(),
    d = await daemon(c),
    target = { conversationId: "local-room" },
    work = d.collaboration.createWork("restart-reminder", target),
    task = d.collaboration.createTask("research", work, target, "finish before the reminder"),
    reminder = d.collaboration.reminders.create("research", work, {
      target,
      content: "check the change after the restart",
      nextAt: Date.now() + 600000,
      timezone: "UTC",
      taskId: task,
    });
  d.collaboration.claim("research", task);
  d.collaboration.update("research", task, "done", "verified");
  await d.close();
  const reopened = await daemon(c);
  // The finished task left the reminder active; only its due time triggers it.
  expect(reopened.collaboration.reminders.read("research", reminder.id).active).toBe(1);
  reopened.collaboration.tick(Date.now() + 700000);
  const delivery = reopened.store.db
    .prepare("SELECT id,agent_id,payload FROM deliveries WHERE agent_id='research'")
    .get() as { id: string; agent_id: string; payload: string };
  expect(delivery.agent_id).toBe("research");
  expect(JSON.parse(delivery.payload)).toMatchObject({
    kind: "reminder",
    reminderId: reminder.id,
    content: "check the change after the restart",
  });
  expect(
    reopened.store.db
      .prepare("SELECT work_id FROM delivery_work WHERE delivery_id=?")
      .get(delivery.id),
  ).toEqual({ work_id: work });
  expect(
    reopened.store.db
      .prepare("SELECT actor_id FROM reminder_firings WHERE reminder_id=?")
      .get(reminder.id),
  ).toEqual({ actor_id: "research" });
  expect(
    reopened.store.db
      .prepare("SELECT actor_id,kind FROM reminder_events WHERE reminder_id=? ORDER BY seq DESC")
      .get(reminder.id),
  ).toEqual({ actor_id: "research", kind: "fired" });
  // The due firing is the author's own durable delivery, resumable as the author's run.
  const run = reopened.store.beginRun("research")!;
  expect([run.agentId, run.deliveryId]).toEqual(["research", delivery.id]);
});
it("applies a changed configuration in place and re-baselines only the changed Agent", async () => {
  credentials();
  const { c } = config(),
    d = await daemon(c),
    before = (
      d.store.db.prepare("SELECT session_id FROM agents WHERE id='research'").get() as {
        session_id: string;
      }
    ).session_id;
  d.local!.receive("owner", "kept", { conversationId: "local-room" }, "kept history");
  const work = d.collaboration.createWork("config-change", { conversationId: "local-room" });
  d.collaboration.enqueue("research", work, "start", {});
  const run = d.store.beginRun("research")!;
  d.store.input(run, { role: "user", content: "SESSION_JOURNAL", timestamp: 0 });
  d.store.finish(run);
  await d.close();
  const next = structuredClone(c);
  next.mate.agents[0]!.role = "An updated role";
  const changed = await daemon(next),
    after = (
      changed.store.db.prepare("SELECT session_id FROM agents WHERE id='research'").get() as {
        session_id: string;
      }
    ).session_id;
  expect(changed.collaboration.agents.get("research").role).toBe("An updated role");
  expect(storedConfiguration(changed.store)).toEqual(next);
  expect(after).not.toBe(before);
  expect(JSON.stringify(changed.store.context(after))).toContain("SESSION_JOURNAL");
  expect(changed.local!.read("owner", { conversationId: "local-room" }).messages[0]!.text).toBe(
    "kept history",
  );
  await changed.close();
  const unchanged = await daemon(next);
  expect(
    unchanged.store.db.prepare("SELECT session_id FROM agents WHERE id='research'").get(),
  ).toEqual({ session_id: after });
});
it("fences a run left active by the previous process before re-baselining a changed configuration", async () => {
  credentials();
  const { c } = config(),
    target = { conversationId: "local-room" },
    d = await daemon(c),
    work = d.collaboration.createWork("crash", target);
  d.collaboration.enqueue("research", work, "unfinished", {});
  const run = d.store.beginRun("research")!;
  d.store.input(run, { role: "user", content: "UNFINISHED", timestamp: 0 });
  await d.close();
  // A process that died with an active run leaves exactly this state behind.
  expect(d.store.db.open).toBe(false);
  const crashed = new Store(join(c.runtime.dataDir, "state", "mate.sqlite"));
  crashed.db.prepare("UPDATE runs SET state='active' WHERE id=?").run(run.id);
  crashed.close();
  const next = structuredClone(c);
  next.mate.agents[0]!.role = "An updated role";
  const recovered = await daemon(next),
    session = (
      recovered.store.db.prepare("SELECT session_id FROM agents WHERE id='research'").get() as {
        session_id: string;
      }
    ).session_id;
  expect(recovered.store.db.prepare("SELECT state FROM runs WHERE id=?").get(run.id)).toEqual({
    state: "interrupted",
  });
  expect(JSON.stringify(recovered.store.context(session))).toContain("UNFINISHED");
  expect(
    recovered.store.db.prepare("SELECT count(*) n FROM runs WHERE state='active'").get(),
  ).toEqual({ n: 0 });
});
it("refuses an occupied database without a readable recorded configuration", async () => {
  credentials();
  const { c } = config();
  c.mate.agents.push({ ...c.mate.agents[0]!, id: "peer", name: "Peer" });
  const first = await daemon(c);
  await first.close();
  const path = join(c.runtime.dataDir, "state", "mate.sqlite"),
    log = { info: () => {}, error: () => {} };
  const withoutPeer = structuredClone(c);
  withoutPeer.mate.agents = [withoutPeer.mate.agents[0]!];
  const store = new Store(path);
  store.db.prepare("DELETE FROM runtime_meta WHERE key='configuration'").run();
  store.close();
  await expect(Daemon.create(withoutPeer, log)).rejects.toThrow(
    /holds Agents that are not in the configuration \(peer\)/,
  );
  const malformed = new Store(path);
  malformed.db.prepare("INSERT INTO runtime_meta VALUES('configuration','not json')").run();
  malformed.close();
  await expect(Daemon.create(withoutPeer, log)).rejects.toThrow(
    /recorded in this data directory is not readable JSON/,
  );
  // The same refusal applies when a readable configuration record is present and a
  // database row belongs to no configured identity at all.
  const recorded = new Store(path);
  recorded.db
    .prepare("UPDATE runtime_meta SET value=? WHERE key='configuration'")
    .run(JSON.stringify(withoutPeer));
  recorded.db
    .prepare("INSERT INTO sessions(id,agent_id,config_version) VALUES('ghost-session','peer','v1')")
    .run();
  recorded.db.prepare("UPDATE agents SET session_id='ghost-session' WHERE id='peer'").run();
  recorded.close();
  await expect(Daemon.create(withoutPeer, log)).rejects.toThrow(
    /holds Agents that are not in the configuration \(peer\)/,
  );
});
it("refuses a configuration that removes an existing Agent identity", async () => {
  credentials();
  const { c } = config();
  c.mate.agents.push({ ...c.mate.agents[0]!, id: "peer", name: "Peer" });
  const d = await daemon(c);
  await d.close();
  const next = structuredClone(c);
  next.mate.agents = [next.mate.agents[0]!];
  await expect(Daemon.create(next, { info: () => {}, error: () => {} })).rejects.toThrow(
    "cannot be removed or rebound",
  );
});
it("rejects unbound external output before an intent and returns internal spaces when discovery fails", async () => {
  const { c } = config(),
    d = await daemon(c),
    m = d.collaboration.messages;
  m.references.createConversation("channel", "external", "external");
  m.membership("research", "external", true);
  expect(() =>
    d.collaboration.output.queue("research", { conversationId: "external" }, "body", "forbidden"),
  ).toThrow("unavailable");
  expect(d.store.output("forbidden")).toBeUndefined();
  const directory = new TeamDirectory(m, {
    spaces: async () => {
      throw new Error("offline");
    },
    members: async () => {
      throw new Error("offline");
    },
    openDM: async () => {
      throw new Error("offline");
    },
  });
  expect(await directory.spaces("research")).toMatchObject({
    spaces: [{ conversationId: "local-room" }],
    coverage: [
      {
        source: "external",
        complete: false,
        reason: "External directory unavailable; internal spaces remain available",
      },
      { source: "internal", complete: true },
    ],
  });
});
it("a stalled adapter flush or rejected replay cannot block internal scheduling; shutdown retains lock until drain", async () => {
  credentials();
  const { c } = config(),
    d = await daemon(c);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const adapter = {
    start: async () => {},
    recover() {},
    poll() {
      throw new Error("offline");
    },
    flush: vi.fn(() => gate),
    close: vi.fn(async () => {}),
  };
  Object.defineProperty(d, "adapter", { value: adapter });
  const tick = vi.spyOn(d.collaboration, "tick"),
    step = vi.spyOn(d.supervisor, "step").mockResolvedValue(false);
  await d.start();
  await vi.waitFor(() => expect(adapter.flush).toHaveBeenCalledOnce());
  const before = step.mock.calls.length;
  await vi.waitFor(() => expect(step.mock.calls.length).toBeGreaterThan(before), { timeout: 1500 });
  expect(tick.mock.calls.length).toBeGreaterThan(1);
  const closing = d.close();
  expect(() => acquireLock(join(c.runtime.dataDir, "state", "daemon.lock"))).toThrow(
    "Another Mate",
  );
  release();
  await closing;
  expect(adapter.close).toHaveBeenCalledOnce();
  acquireLock(join(c.runtime.dataDir, "state", "daemon.lock"))();
});
it("failed startup closes owned resources and releases the singleton lock automatically", async () => {
  credentials();
  const { c } = config(),
    d = await daemon(c);
  const close = vi.fn(async () => {});
  Object.defineProperty(d, "adapter", {
    value: {
      start: async () => {
        throw new Error("partial start");
      },
      recover() {},
      poll() {},
      flush: async () => {},
      close,
    },
  });
  await expect(d.start()).rejects.toThrow("partial start");
  expect(close).toHaveBeenCalledOnce();
  acquireLock(join(c.runtime.dataDir, "state", "daemon.lock"))();
  await d.close();
});
it("JSONL console reports request errors and the real CLI starts, reads and controls the same local store", async () => {
  const { c, root } = config(),
    d = await daemon(c),
    input = new PassThrough(),
    output = new PassThrough();
  let text = "";
  output.on("data", (v) => (text += v));
  const serving = new LocalConsole(d.local!, d.controls).serve(
    input,
    output,
    new AbortController().signal,
  );
  input.end("{bad\n" + JSON.stringify({ id: "rooms", op: "rooms", human: "owner" }) + "\n");
  await serving;
  expect(JSON.parse(text.split("\n")[0]!)).toHaveProperty("error");
  expect(JSON.parse(text.split("\n")[1]!).result).toEqual([{ conversationId: "local-room" }]);
  await d.close();
  const path = join(root, "config.json");
  writeFileSync(path, JSON.stringify(c));
  const lines = [
    { id: "pause", op: "control", human: "owner", text: "agent-stop research" },
    {
      id: "send",
      op: "send",
      human: "owner",
      eventId: "cli-message",
      target: { conversationId: "local-room" },
      text: "from real CLI",
    },
    { id: "read", op: "read", human: "owner", target: { conversationId: "local-room" } },
  ];
  const result = execFileSync(process.execPath, [resolve("dist/src/main.js"), "local", path], {
    input: lines.map((x) => JSON.stringify(x)).join("\n") + "\n",
    env: { ...process.env, MODEL_API_KEY: "synthetic" },
    encoding: "utf8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const replies = result
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(replies).toHaveLength(3);
  expect(replies[2].result.messages[0].text).toBe("from real CLI");
});
it("removing and explicitly re-adding a local room preserves history and requires an explicit membership delta again", async () => {
  const { c, root } = config(),
    d = await daemon(c);
  d.local!.receive("owner", "kept", { conversationId: "local-room" }, "kept history");
  await d.close();
  const removed = structuredClone(c);
  removed.adapters.local!.rooms = [];
  const r = await daemon(removed);
  expect(r.local!.rooms("owner")).toEqual([]);
  expect(r.collaboration.messages.access("research", "local-room")).toBe(false);
  await r.close();
  const added = await daemon(c);
  expect(added.local!.read("owner", { conversationId: "local-room" }).messages[0]!.text).toBe(
    "kept history",
  );
  expect(added.collaboration.messages.access("research", "local-room")).toBe(true);
});
it("internal publication bypasses an unrelated in-flight external request and ready limits do not hide internal work", async () => {
  const { c } = config(),
    d = await daemon(c),
    m = d.collaboration.messages,
    s = d.store,
    out = d.collaboration.output;
  m.references.createConversation("channel", "external", "external");
  m.membership("research", "external", true);
  vi.spyOn(m, "requirePublication").mockImplementation(() => {});
  const internalWork = d.collaboration.createWork("internal", { conversationId: "local-room" }),
    externalWork = d.collaboration.createWork("external", { conversationId: "external" });
  d.collaboration.enqueue("research", internalWork, "manual-run", {});
  const run = s.beginRun("research")!;
  s.input(run, {});
  const queue = (id: string, conversationId: string, work: string) => {
    d.collaboration.send("research", work, { conversationId }, id, id, { run });
    const draft = out.gate!.describe("research", id) as any;
    out.gate!.continueOnce(run, id, 1, draft.holdId);
  };
  for (let n = 0; n < 22; n++) queue("external-" + n, "external", externalWork);
  queue("internal", "local-room", internalWork);
  expect(out.ready(20, "internal")).toEqual([{ id: "internal" }]);
  let reject!: (e: Error) => void;
  const gate = new Promise<never>((_, r) => (reject = r));
  vi.spyOn(out.transport, "post").mockImplementation(() => gate);
  const sending = out.send("external-0");
  await vi.waitFor(() => expect(s.output("external-0")!.state).toBe("sending"));
  await out.send("internal");
  expect(s.output("internal")!.state).toBe("sent");
  reject(new Error("offline"));
  await sending;
});
it("an adapter close error still drains background work before DB close and lock release", async () => {
  credentials();
  const { c } = config(),
    d = await daemon(c);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const adapter = {
    start: async () => {},
    recover() {},
    poll() {},
    flush: vi.fn(() => gate),
    close: async () => {
      throw new Error("close failed");
    },
  };
  Object.defineProperty(d, "adapter", { value: adapter });
  vi.spyOn(d.supervisor, "step").mockResolvedValue(false);
  await d.start();
  await vi.waitFor(() => expect(adapter.flush).toHaveBeenCalledOnce());
  const closing = d.close();
  const assertion = expect(closing).rejects.toThrow("cleanup failed");
  await Promise.resolve();
  expect(() => acquireLock(join(c.runtime.dataDir, "state", "daemon.lock"))).toThrow(
    "Another Mate",
  );
  expect(d.store.db.prepare("SELECT 1").get()).toBeDefined();
  release();
  await assertion;
  acquireLock(join(c.runtime.dataDir, "state", "daemon.lock"))();
  // The idempotent close retains its original error; test cleanup deliberately consumes it.
  clean.push(() => {
    Object.defineProperty(d, "close", { value: () => closing.catch(() => {}) });
  });
});
