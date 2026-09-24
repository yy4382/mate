import { fixtureTarget } from "../helpers/canonical-slack.js";
import { afterEach, expect, it } from "vitest";
import { Store } from "../../src/storage/store.js";
import { Messages, Output, anchorMessage, anchoredTask } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { CanonicalAttention } from "../../src/conversations/attention.js";
import { CanonicalFreshnessGate } from "../../src/conversations/freshness.js";
import { ToolRouter } from "../../src/runtime/tools.js";
import { Broker } from "../../src/policy/broker.js";
import { configFixture } from "../helpers/config.js";
import { configSchema } from "../../src/config.js";

/** A queued publication waits for an explicit decision before dispatch, as freshness intends. */
function release(store: Store, outboxId: string): void {
  if (store.output(outboxId)?.state === "held") store.transitionOutput(outboxId, "held", "pending");
}

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
const target = fixtureTarget("CTEST", "100.000001");

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
  const store = new Store(":memory:");
  stores.push(store);
  const messages = new Messages(store, config),
    attention = new CanonicalAttention(messages),
    output = new Output(messages, { post: async () => ({ ts: "200.000001" }) }, Date.now);
  const collaboration = new Collaboration(store, messages, output, config, attention);
  // The application assembly shares one task module between the gate and the service; the gate
  // here observes the revision call instead of writing task state itself.
  const revisions: { outboxId: string; nextOutboxId: string; target: unknown }[] = [];
  const gate = new CanonicalFreshnessGate(messages, attention, Date.now, {
    republish: (actor, previousOutboxId, nextOutboxId, revisedTarget) => {
      revisions.push({ outboxId: previousOutboxId, nextOutboxId, target: revisedTarget });
      collaboration.tasks.republish(actor, previousOutboxId, nextOutboxId, revisedTarget);
    },
  });
  output.attachGate(gate);
  const router = new ToolRouter(
    collaboration,
    new Broker(
      store,
      collaboration,
      { execute: async () => ({ code: 0, stdout: "", stderr: "", truncated: false }) },
      {},
    ),
  );
  for (const agent of config.agents) {
    store.register(agent.id, "v1", []);
    messages.membership(agent.id, "CTEST", true);
  }
  const work = collaboration.createWork("root", target);
  collaboration.enqueue("research", work, "start", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  return { store, messages, collaboration, output, gate, router, work, run, revisions };
}

it("the task module owns the message a task is published as, and republishing keeps one task", async () => {
  const { store, collaboration: c, output, work, run, revisions } = setup();
  const task = c.publishTask(
    "research",
    c.draftTask({
      agentId: "research",
      workId: work,
      target,
      title: "announce the plan",
      pendingOutboxId: "task-publish:plan",
    }),
    "announce the plan",
    { run },
  );
  expect(task.status).toBe("draft");
  expect(task.message_key).toBeNull();
  const outboxId = task.outbox_id!,
    draft = c.output.gate!.describe("research", outboxId) as any;
  c.output.gate!.continueOnce(run, outboxId, draft.revision, draft.holdId);
  await output.send(outboxId);
  c.activateDelegations();

  const published = c.task(task.id),
    messageKey = c.messages.records.confirmedMessageId(outboxId);
  expect(published.message_key).toBe(messageKey);
  expect(published.status).toBe("todo");
  expect(c.tasks.findForMessage(messageKey)!.id).toBe(task.id);
  expect(
    store.db.prepare("SELECT count(*) n FROM tasks WHERE message_key=?").get(messageKey),
  ).toEqual({ n: 1 });

  // Repeating the same confirmation is a no-op, and a second task cannot claim the message.
  const version = published.version;
  c.tasks.confirm("research", outboxId, messageKey, target.conversationId);
  expect(c.task(task.id).version).toBe(version);
  const rival = anchoredTask(c, "research", work, target, "rival");
  expect(() =>
    c.tasks.confirm("research", c.task(rival).outbox_id!, messageKey, target.conversationId),
  ).toThrow("Conflicting task anchor");
  expect(c.task(task.id).version).toBe(version);
  expect(c.task(task.id).message_key).toBe(messageKey);

  // A held draft that gets revised follows the replacement publication in one task transition.
  const heldId = c.draftTask({
      agentId: "research",
      workId: work,
      target,
      title: "second",
      pendingOutboxId: "task-publish-reservation:second",
    }),
    held = c.publishTask("research", heldId, "second text", { run }),
    heldOutbox = held.outbox_id!,
    heldDraft = c.output.gate!.describe("research", heldOutbox) as any;
  expect(heldDraft.status).toBe("held");
  revisions.length = 0;
  c.output.gate!.revise(run, heldOutbox, heldDraft.revision, "revised second");
  expect(revisions).toHaveLength(1);
  expect(revisions[0]).toMatchObject({
    outboxId: heldOutbox,
    nextOutboxId: `${heldOutbox}:revision:2`,
  });
  expect(c.task(heldId).outbox_id).toBe(`${heldOutbox}:revision:2`);
  expect(c.task(heldId).status).toBe("draft");
  expect(store.db.prepare("SELECT count(*) n FROM tasks WHERE title='second'").get()).toEqual({
    n: 1,
  });
});

it("a failed, unknown or restarted publication leaves exactly one canonical task", () => {
  const { store, collaboration: c, work } = setup();
  const failedReservation = "task-publish-reservation:failed",
    unknownReservation = "task-publish-reservation:unknown",
    failed = c.publishTask(
      "research",
      c.draftTask({
        agentId: "research",
        workId: work,
        target,
        title: "failed publication",
        pendingOutboxId: failedReservation,
      }),
      "failed publication",
    );
  const unknown = c.publishTask(
    "research",
    c.draftTask({
      agentId: "research",
      workId: work,
      target,
      title: "unknown publication",
      pendingOutboxId: unknownReservation,
    }),
    "unknown publication",
  );
  const failedOutbox = failed.outbox_id!,
    unknownOutbox = unknown.outbox_id!;
  release(store, failedOutbox);
  release(store, unknownOutbox);
  store.transitionOutput(failedOutbox, "pending", "sending");
  store.transitionOutput(failedOutbox, "sending", "failed", { reason: "not_in_channel" });
  store.transitionOutput(unknownOutbox, "pending", "sending");
  store.transitionOutput(unknownOutbox, "sending", "unknown", { reason: "timeout" });

  c.activateDelegations();
  expect(c.task(failed.id).status).toBe("failed");
  expect(c.task(unknown.id).status).toBe("failed");
  const events = (taskId: string) =>
    (
      store.db.prepare("SELECT body FROM task_events WHERE task_id=? ORDER BY id").all(taskId) as {
        body: string;
      }[]
    ).map((row) => JSON.parse(row.body));
  expect(events(failed.id).at(-1)).toMatchObject({
    action: "publication_failed",
    cause: { reason: "not_in_channel" },
  });
  expect(events(unknown.id).at(-1)).toMatchObject({
    action: "publication_unknown",
    cause: { reason: "timeout" },
  });

  // A restart repeats the same recovery pass; both tasks keep their one publication anchor.
  c.activateDelegations();
  c.activateDelegations();
  expect(
    store.db
      .prepare("SELECT count(*) n FROM tasks WHERE title IN (?,?)")
      .get("failed publication", "unknown publication"),
  ).toEqual({ n: 2 });
  expect(c.task(failed.id).message_key).toBeNull();
  expect(c.task(unknown.id).message_key).toBeNull();
  expect(store.output(failedOutbox)?.state).toBe("failed");
  expect(store.output(unknownOutbox)?.state).toBe("unknown");
});

it("a message anchor resolves claim, yield, hand-over and update to one task with CAS results", () => {
  const { store, collaboration: c, router, work, run } = setup();
  const anchor = anchorMessage(c, target),
    coord = router.coordination,
    claimed = coord.submit(run, work, "claim", "tasks.claim", {
      anchor: { messageId: anchor },
      expectedVersion: 0,
    }) as any;
  expect(claimed.status).toBe("held");
  const applied = coord.continue(run, "claim", claimed.holdId) as any,
    task = applied.result;
  expect(task.owner).toBe("research");
  expect(task.message_key).toBe(anchor);

  // A claim prepared at the version before that change reports the conflict instead of overwriting.
  const rival = anchorMessage(c, target);
  c.tasks.create({
    agentId: "research",
    workId: work,
    target,
    title: "rival",
    messageKey: rival,
    pendingOutboxId: "task-publish:rival",
  });
  const stale = coord.submit(run, work, "stale", "tasks.update", {
    taskId: task.id,
    status: "done",
    result: "done by whoever",
    expectedVersion: task.version - 1,
  }) as any;
  const conflict = coord.continue(run, "stale", stale.holdId) as any;
  expect(conflict.conflict).toBe("task_version");
  expect(conflict.expectedVersion).toBe(task.version - 1);
  expect(conflict.currentVersion).toBe(c.task(task.id).version);
  expect(conflict.task).toMatchObject({ id: task.id, owner: "research" });
  expect(conflict.steps[1]).toMatchObject({ tool: "tasks.continue" });
  expect(c.task(task.id).status).toBe("doing");

  // The same intent, acknowledged with the current version, applies once.
  const acknowledged = coord.continue(run, "stale", conflict.holdId) as any;
  expect(acknowledged.result.status).toBe("done");
  expect(c.task(task.id).status).toBe("done");
  expect(store.db.prepare("SELECT count(*) n FROM tasks WHERE message_key=?").get(anchor)).toEqual({
    n: 1,
  });

  // Claim, yield and hand over move the same anchored task through its own versioned events.
  const rivalClaim = coord.submit(run, work, "rival-claim", "tasks.claim", {
    anchor: { messageId: rival },
    expectedVersion: 0,
  }) as any;
  const rivalTask = (coord.continue(run, "rival-claim", rivalClaim.holdId) as any).result;
  expect(rivalTask).toMatchObject({ message_key: rival, owner: "research", status: "doing" });
  const released = coord.submit(run, work, "yield", "tasks.unclaim", {
    taskId: rivalTask.id,
    expectedVersion: c.task(rivalTask.id).version,
  }) as any;
  const yielded = (coord.continue(run, "yield", released.holdId) as any).result;
  expect(yielded).toMatchObject({ owner: null, status: "todo" });
  const reclaimed = coord.submit(run, work, "reclaim", "tasks.claim", {
    taskId: yielded.id,
    expectedVersion: yielded.version,
  }) as any;
  coord.continue(run, "reclaim", reclaimed.holdId);
  const handOver = coord.submit(run, work, "hand-over", "tasks.transfer", {
    taskId: yielded.id,
    peerId: "peer",
    expectedVersion: c.task(yielded.id).version,
  }) as any;
  const handed = (coord.continue(run, "hand-over", handOver.holdId) as any).result;
  expect(handed).toMatchObject({ owner: "peer", status: "doing" });
  const events = store.db
    .prepare("SELECT body FROM task_events WHERE task_id=? ORDER BY id")
    .all(yielded.id) as { body: string }[];
  expect(events.map((row) => JSON.parse(row.body).action)).toEqual(
    expect.arrayContaining(["create", "claim", "tasks.unclaim", "tasks.transfer"]),
  );
  expect(events.map((row) => JSON.parse(row.body).version)).toEqual(
    Array.from({ length: handed.version + 1 }, (_, index) => index),
  );
});

it("an Agent can converse directly without creating any task", () => {
  const { store, collaboration: c, output, work, run } = setup();
  const id = c.send("research", work, target, "just talking", "plain-message", { run });
  release(store, id);
  store.transitionOutput(id, "pending", "sending");
  store.transitionOutput(id, "sending", "sent", { messageId: "plain" });
  c.activateDelegations();
  expect(store.db.prepare("SELECT count(*) n FROM tasks").get()).toEqual({ n: 0 });
  expect(output.ready()).toEqual([]);
});
