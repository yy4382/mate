import { fixtureTarget, externalThread } from "../helpers/canonical-slack.js";
import { afterEach, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Store } from "../../src/storage/store.js";
import { Messages, Output, anchoredTask } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { CanonicalAttention } from "../../src/conversations/attention.js";
import { CanonicalFreshnessGate } from "../../src/conversations/freshness.js";
import { Broker } from "../../src/policy/broker.js";
import { ToolRouter } from "../../src/runtime/tools.js";
import { configFixture } from "../helpers/config.js";
import { configSchema } from "../../src/config.js";
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
const target = fixtureTarget("CTEST", "100.000001"),
  ref = { messageId: target.threadId };
function setup() {
  const config = configSchema.parse({
    ...configFixture,
    agents: [
      configFixture.agents[0],
      {
        ...configFixture.agents[0],
        id: "peer",
        slackAppId: "ATWO",
        slackUserId: "UTWO",
        slackBotId: "BTWO",
        botTokenEnv: "PEER_BOT",
        appTokenEnv: "PEER_APP",
      },
    ],
  });
  const s = new Store(":memory:");
  stores.push(s);
  const m = new Messages(s, config);
  const attention = new CanonicalAttention(m),
    gate = new CanonicalFreshnessGate(m, attention),
    c = new Collaboration(
      s,
      m,
      new Output(m, { post: async () => ({ ts: "200.000001" }) }, Date.now, gate),
      config,
      attention,
    ),
    router = new ToolRouter(
      c,
      new Broker(
        s,
        c,
        { execute: async () => ({ code: 0, stdout: "", stderr: "", truncated: false }) },
        {},
      ),
    );
  for (const a of config.agents) {
    s.register(a.id, "v1", []);
    m.membership(a.id, "CTEST", true);
  }
  const work = c.createWork("root", target);
  m.record(
    {
      team: "TTEST",
      channel: target.conversationId,
      thread: externalThread(target),
      ts: externalThread(target),
      revision: externalThread(target),
      text: "Canonical request",
      user: "UOWNER",
      deleted: false,
    },
    ["research", "peer"],
  );
  const runs = config.agents.map((a) => {
    c.enqueue(a.id, work, "start", {});
    const r = s.beginRun(a.id)!;
    s.input(r, {});
    return r;
  });
  return { s, m, c, router, work, runs };
}
it("two held claims do not create tasks; the loser gets an actionable version conflict", () => {
  const { c, router, work, runs } = setup(),
    coord = router.coordination;
  const a = coord.submit(runs[0]!, work, "a", "tasks.claim", {
      message: ref,
      expectedVersion: 0,
    }) as any,
    b = coord.submit(runs[1]!, work, "b", "tasks.claim", {
      message: ref,
      expectedVersion: 0,
    }) as any;
  expect(c.list("research")).toHaveLength(0);
  const applied = coord.continue(runs[0]!, "a", a.holdId) as any;
  expect(applied.result.owner).toBe("research");
  c.activateDelegations();
  const losing = coord.continue(runs[1]!, "b", b.holdId) as any;
  expect(losing.status).toBe("held");
  expect(losing.conflict).toBe("task_version");
  expect(losing.expectedVersion).toBe(0);
  expect(losing.currentVersion).toBe(c.task(applied.result.id).version);
  expect(losing.task).toMatchObject({ id: applied.result.id, owner: "research" });
  expect(losing.steps.map((step: any) => step.tool)).toEqual([
    "tasks.read",
    "tasks.continue",
    "tasks.discard",
  ]);
  expect(c.task(applied.result.id).owner).toBe("research");
  expect(c.list("research")).toHaveLength(1);
});
it("unclaim and transfer are CAS operations, not freshness overrides of ownership", () => {
  const { c, router, work, runs } = setup(),
    coord = router.coordination;
  const held = coord.submit(runs[0]!, work, "claim", "tasks.claim", {
    message: ref,
    expectedVersion: 0,
  }) as any;
  const task = (coord.continue(runs[0]!, "claim", held.holdId) as any).result;
  const unclaim = coord.submit(runs[0]!, work, "unclaim", "tasks.unclaim", {
    taskId: task.id,
    expectedVersion: task.version,
  }) as any;
  coord.continue(runs[0]!, "unclaim", unclaim.holdId);
  expect(c.task(task.id).owner).toBeNull();
  const again = coord.submit(runs[0]!, work, "again", "tasks.claim", {
    taskId: task.id,
    expectedVersion: c.task(task.id).version,
  }) as any;
  coord.continue(runs[0]!, "again", again.holdId);
  const transfer = coord.submit(runs[0]!, work, "transfer", "tasks.transfer", {
    taskId: task.id,
    peerId: "peer",
    expectedVersion: c.task(task.id).version,
  }) as any;
  coord.continue(runs[0]!, "transfer", transfer.holdId);
  expect(c.task(task.id).owner).toBe("peer");
  const steal = coord.submit(runs[0]!, work, "steal", "tasks.update", {
    taskId: task.id,
    expectedVersion: c.task(task.id).version,
    status: "done",
    result: "claiming credit",
  }) as any;
  expect(() => coord.continue(runs[0]!, "steal", steal.holdId)).toThrow("owned");
});
it("new task remains an unclaimable draft until its canonical message has a visible receipt", async () => {
  const { c, router, work, runs, s, m } = setup();
  const run = runs[0]!,
    task = router.coordination.create(run, work, target, "new independent work");
  expect(task.status).toBe("draft");
  expect(() => c.claim("research", task.id)).toThrow("unavailable");
  const draft = router.gate.describe("research", task.outbox_id!) as any;
  router.gate.continueOnce(run, draft.draftId, 1, draft.holdId);
  await c.output.send(task.outbox_id!);
  c.activateDelegations();
  const active = c.task(task.id);
  expect(active.message_key).toBe(m.mapper.messageId("CTEST", "200.000001"));
  expect(active.status).toBe("todo");
  expect(
    s.db.prepare("SELECT count(*) n FROM tasks WHERE message_key=?").get(active.message_key),
  ).toEqual({ n: 1 });
});
it("peer claim after visible send but before polling reuses the pending task instead of duplicating it", async () => {
  const { c, router, work, runs } = setup();
  const task = router.coordination.create(runs[0]!, work, target, "new task");
  const draft = router.gate.describe("research", task.outbox_id!) as any;
  router.gate.continueOnce(runs[0]!, draft.draftId, 1, draft.holdId);
  await c.output.send(task.outbox_id!);
  const message = { messageId: c.messages.records.confirmedMessageId(task.outbox_id!) };
  const visible = router.coordination.find("peer", message)!;
  const held = router.coordination.submit(runs[1]!, work, "race", "tasks.claim", {
    message,
    expectedVersion: visible.version,
  }) as any;
  const applied = router.coordination.continue(runs[1]!, "race", held.holdId) as any;
  expect(applied.result.id).toBe(task.id);
  expect(applied.result.owner).toBe("peer");
  expect(() => c.activateDelegations()).not.toThrow();
  expect(c.list("research")).toHaveLength(1);
});
it("a top-level created task can be claimed by ID using the confirmed root thread", async () => {
  const { c, router, work, runs } = setup();
  const task = router.coordination.create(
    runs[0]!,
    work,
    { conversationId: "CTEST" },
    "top-level task",
  );
  const draft = router.gate.describe("research", task.outbox_id!) as any;
  router.gate.continueOnce(runs[0]!, draft.draftId, 1, draft.holdId);
  await c.output.send(task.outbox_id!);
  c.activateDelegations();
  const held = router.coordination.submit(runs[0]!, work, "claim-top", "tasks.claim", {
    taskId: task.id,
    expectedVersion: c.task(task.id).version,
  }) as any;
  expect(
    (router.coordination.continue(runs[0]!, "claim-top", held.holdId) as any).result.owner,
  ).toBe("research");
});
it("completing a dependency persists the wakeup while its waiter activity is paused", () => {
  const { s, c, work, runs } = setup();
  const other = c.createWork("other", target),
    waiter = anchoredTask(c, "research", work, target, "wait"),
    dependency = anchoredTask(c, "peer", other, target, "dependency");
  c.claim("research", waiter);
  c.claim("peer", dependency);
  c.wait("research", waiter, dependency);
  c.control("UOWNER", work, "pause");
  c.update("peer", dependency, "done", "finished");
  expect(c.task(dependency).status).toBe("done");
  expect(
    s.db
      .prepare(
        "SELECT count(*) n FROM deliveries WHERE json_extract(payload,'$.kind')='dependency'",
      )
      .get(),
  ).toEqual({ n: 1 });
  expect(s.beginRun("research", Date.now(), true)).toBeUndefined();
  c.control("UOWNER", work, "resume");
  expect(s.beginRun("research", Date.now(), true)).toBeDefined();
});
it("waiting is a gated CAS mutation and only releases the run after applying", async () => {
  const { c, router, work, runs } = setup(),
    task = anchoredTask(c, "research", work, target, "wait"),
    dependency = anchoredTask(c, "peer", work, target, "dep");
  c.claim("research", task);
  const signal = new AbortController().signal;
  const held = await router.call(
    runs[0]!,
    work,
    "wait",
    "tasks.wait",
    { taskId: task, dependencyId: dependency, expectedVersion: c.task(task).version },
    signal,
  );
  expect(held.wait).toBe(false);
  expect(c.task(task).status).toBe("doing");
  const value = held.value as any;
  const applied = await router.call(
    runs[0]!,
    work,
    "apply-wait",
    "tasks.continue",
    {
      intentId: value.intentId,
      holdId: value.holdId,
      acknowledge: "apply_despite_unread_or_changes",
    },
    signal,
  );
  expect(applied.wait).toBe(true);
  expect(c.task(task).status).toBe("waiting");
});
it("waiting on a terminal dependency is a no-op or releases an existing wait without duplicate projection", () => {
  const { c, router, work, runs } = setup(),
    coord = router.coordination,
    run = runs[0]!;
  const held = coord.submit(run, work, "claim", "tasks.claim", {
    message: ref,
    expectedVersion: 0,
  }) as any;
  const task = (coord.continue(run, "claim", held.holdId) as any).result;
  const done = anchoredTask(c, "peer", work, target, "done"),
    pending = anchoredTask(c, "peer", work, target, "pending");
  c.claim("peer", done);
  c.update("peer", done, "done", "finished");
  const first = coord.submit(run, work, "wait-done", "tasks.wait", {
    taskId: task.id,
    dependencyId: done,
    expectedVersion: task.version,
  }) as any;
  expect((coord.continue(run, "wait-done", first.holdId) as any).result.status).toBe("doing");
  c.wait("research", task.id, pending);
  const next = coord.submit(run, work, "release", "tasks.wait", {
    taskId: task.id,
    dependencyId: done,
    expectedVersion: c.task(task.id).version,
  }) as any;
  expect((coord.continue(run, "release", next.holdId) as any).result.status).toBe("doing");
  expect(c.task(task.id).waiting_on).toBeNull();
});

it("every anchored task mutation is reachable through the tool surface by message anchor", async () => {
  const { c, router, work, runs } = setup(),
    run = runs[0]!,
    peerRun = runs[1]!,
    signal = new AbortController().signal,
    call = async (callId: string, operation: string, input: unknown, actor = run) =>
      (await router.call(actor, work, callId, operation, input, signal)).value as any,
    hold = async (callId: string, operation: string, input: unknown, actor = run) => {
      const held = await call(callId, operation, input, actor);
      return (await call(
        `${callId}-apply`,
        "tasks.continue",
        {
          intentId: held.intentId,
          holdId: held.holdId,
          acknowledge: "apply_despite_unread_or_changes",
        },
        actor,
      )) as any;
    };
  const claimed = await hold("anchor-claim", "tasks.claim", {
      anchor: ref,
      expectedVersion: 0,
    }),
    task = claimed.result;
  expect(task).toMatchObject({ owner: "research", message_key: ref.messageId });
  const yielded = await hold("anchor-yield", "tasks.unclaim", {
    anchor: ref,
    expectedVersion: task.version,
  });
  expect(yielded.result).toMatchObject({ owner: null, status: "todo" });
  const reclaimed = await hold("anchor-reclaim", "tasks.claim", {
    anchor: ref,
    expectedVersion: yielded.result.version,
  });
  expect(reclaimed.result.owner).toBe("research");
  const handed = await hold("anchor-transfer", "tasks.transfer", {
    anchor: ref,
    peerId: "peer",
    expectedVersion: reclaimed.result.version,
  });
  expect(handed.result).toMatchObject({ owner: "peer", status: "doing" });
  const updated = await hold(
    "anchor-update",
    "tasks.update",
    {
      anchor: ref,
      status: "done",
      result: "peer finished it",
      expectedVersion: handed.result.version,
    },
    peerRun,
  );
  expect(updated.result.status).toBe("done");
  expect(
    c.store.db.prepare("SELECT COUNT(*) n FROM tasks WHERE message_key=?").get(ref.messageId),
  ).toEqual({ n: 1 });
});

it("a claim by anchor confirms the pending publication instead of creating a second task", async () => {
  const { c, router, work, runs, m } = setup(),
    run = runs[0]!,
    task = router.coordination.create(run, work, target, "claimed before polling"),
    draft = router.gate.describe("research", task.outbox_id!) as any;
  router.gate.continueOnce(run, draft.draftId, draft.revision, draft.holdId);
  await c.output.send(task.outbox_id!);
  const view = c.attention.read(run, target) as any;
  c.attention.presented(run, {
    role: "toolResult",
    toolCallId: "read",
    toolName: "mate",
    content: [{ type: "text", text: JSON.stringify(view) }],
    isError: false,
    timestamp: 0,
  } as AgentMessage);
  const message = { messageId: m.mapper.messageId("CTEST", "200.000001") };
  // The poll that links a visible publication to its task reconciles it whatever the work state.
  const found = router.coordination.find("research", message);
  expect(found?.id).toBe(task.id);
  // No tasks.byMessage lookup first: the claim itself must find and confirm the pending task.
  const held = router.coordination.submit(
      run,
      work,
      "early-claim",
      "tasks.claim",
      { anchor: message, expectedVersion: 0 },
      view.viewToken,
    ) as any,
    applied = router.coordination.continue(run, "early-claim", held.holdId) as any;
  expect(applied.result.id).toBe(task.id);
  expect(applied.result).toMatchObject({ owner: "research", message_key: message.messageId });
  expect(
    c.store.db.prepare("SELECT COUNT(*) n FROM tasks WHERE message_key=?").get(message.messageId),
  ).toEqual({ n: 1 });
  expect(() => c.activateDelegations()).not.toThrow();
});

it("a claim by anchor reconciles a pending publication even while its work is paused", async () => {
  const { c, router, work, runs, m } = setup(),
    run = runs[0]!,
    task = router.coordination.create(run, work, target, "paused publication"),
    draft = router.gate.describe("research", task.outbox_id!) as any;
  router.gate.continueOnce(run, draft.draftId, draft.revision, draft.holdId);
  await c.output.send(task.outbox_id!);
  const view = c.attention.read(run, target) as any;
  c.attention.presented(run, {
    role: "toolResult",
    toolCallId: "read",
    toolName: "mate",
    content: [{ type: "text", text: JSON.stringify(view) }],
    isError: false,
    timestamp: 0,
  } as AgentMessage);
  // The owner pauses the activity between the visible send and the confirmation poll.
  c.control("UOWNER", work, "pause");
  const message = { messageId: m.mapper.messageId("CTEST", "200.000001") };
  // The poll that links a visible publication to its task reconciles it whatever the work state.
  const found = router.coordination.find("research", message);
  expect(found?.id).toBe(task.id);
  expect(
    c.store.db.prepare("SELECT COUNT(*) n FROM tasks WHERE message_key=?").get(message.messageId),
  ).toEqual({ n: 1 });
});
