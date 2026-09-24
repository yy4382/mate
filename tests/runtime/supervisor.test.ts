import { fixtureTarget, externalThread } from "../helpers/canonical-slack.js";
import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "../helpers/pi.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Store } from "../../src/storage/store.js";
import { configSchema } from "../../src/config.js";
import { configFixture } from "../helpers/config.js";
import { Messages, Output, anchoredTask } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { CanonicalAttention } from "../../src/conversations/attention.js";
import { CanonicalFreshnessGate } from "../../src/conversations/freshness.js";
import { Broker } from "../../src/policy/broker.js";
import { Supervisor, type Worker } from "../../src/runtime/supervisor.js";
import { WorkerClient } from "../../src/runtime/client.js";
import { ToolRouter } from "../../src/runtime/tools.js";
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
function setup(factory?: (id: string) => Worker) {
  const config = configSchema.parse({
    ...configFixture,
    agents: [
      configFixture.agents[0],
      {
        ...configFixture.agents[0],
        id: "writer",
        name: "Writer",
        slackAppId: "ATWO",
        slackUserId: "UTWO",
        slackBotId: "BTWO",
        botTokenEnv: "WRITER_BOT",
        appTokenEnv: "WRITER_APP",
      },
    ],
  });
  const store = new Store(":memory:"),
    messages = new Messages(store, config);
  const attention = new CanonicalAttention(messages),
    output = new Output(
      messages,
      { post: async () => ({ ts: "100.000002" }) },
      Date.now,
      new CanonicalFreshnessGate(messages, attention),
    ),
    collaboration = new Collaboration(store, messages, output, config, attention);
  const broker = new Broker(
    store,
    collaboration,
    { execute: async () => ({ code: 0, stdout: "", stderr: "", truncated: false }) },
    { research: "/tmp", writer: "/tmp" },
  );
  const router = new ToolRouter(collaboration, broker);
  const supervisor = new Supervisor(
    collaboration,
    router,
    config,
    (agent) =>
      factory?.(agent.id) ??
      new WorkerClient(
        "test",
        "test",
        "only-provider-secret",
        new URL("../../dist/tests/helpers/worker-fixture.js", import.meta.url),
      ),
  );
  supervisor.register();
  for (const agent of config.agents)
    for (const channel of ["CTEST", "CTWO"]) messages.membership(agent.id, channel, true);
  const work = collaboration.createWork("human:one", fixtureTarget("CTEST", "100.000001"));
  cleanups.push(() => {
    supervisor.close();
    store.close();
  });
  return { config, store, collaboration, supervisor, router, broker, work };
}
function last(store: Store, agent: string) {
  const row = store.db.prepare("SELECT session_id FROM agents WHERE id=?").get(agent) as {
    session_id: string;
  };
  const message = (store.context(row.session_id) as AgentMessage[]).findLast(
    (m) => m.role === "assistant",
  );
  if (message?.role !== "assistant" || message.content[0]?.type !== "text")
    throw new Error("No assistant result");
  return { session: row.session_id, data: JSON.parse(message.content[0].text) };
}
it("never starts a worker process when shutdown arrives while a run is preparing", async () => {
  let created = 0;
  const f = setup(),
    preparation = deferred(),
    recovery = vi.fn(async () => {
      entered();
      await preparation.promise;
      return "";
    });
  let entered!: () => void;
  const preparing = new Promise<void>((resolve) => (entered = resolve));
  const supervisor = new Supervisor(
    f.collaboration,
    f.router,
    f.config,
    () => {
      created++;
      return {
        run: async () => ({
          certain: true,
          tokens: 1,
          cost: 0,
          continuation: false,
          waiting: false,
        }),
        close() {},
      };
    },
    recovery,
  );
  supervisor.register();
  try {
    f.collaboration.enqueue("research", f.work, "preparing", {});
    const stepping = supervisor.step("research");
    // Shutdown arrives inside the window between run preparation and worker creation.
    await preparing;
    supervisor.close();
    preparation.resolve();
    await stepping;
    expect(recovery).toHaveBeenCalledOnce();
    expect(created).toBe(0);
    expect(f.store.db.prepare("SELECT state FROM runs WHERE agent_id='research'").get()).toEqual({
      state: "failed",
    });
    // Once stopped, the supervisor refuses a queued run outright.
    f.collaboration.enqueue("research", f.work, "after-stop", {});
    expect(await supervisor.step("research")).toBe(false);
    expect(created).toBe(0);
  } finally {
    supervisor.close();
  }
});
it("real worker processes retain cross-channel context and isolate Agent state and inherited secrets", async () => {
  process.env.SYNTHETIC_SLACK_SECRET = "must-not-inherit";
  try {
    const { store, collaboration: c, supervisor, work } = setup();
    c.enqueue("research", work, "channel-one", {
      text: "first private input",
      target: fixtureTarget("CTEST", "100.000001"),
    });
    await supervisor.step("research");
    const first = last(store, "research");
    c.enqueue("research", work, "channel-two", {
      text: "second channel",
      target: fixtureTarget("CTWO", "100.000001"),
    });
    c.enqueue("writer", work, "writer-one", { text: "writer only" });
    await Promise.all([supervisor.step("research"), supervisor.step("writer")]);
    const second = last(store, "research"),
      writer = last(store, "writer");
    expect(second.session).toBe(first.session);
    expect(second.data.calls).toBe(2);
    expect(second.data.pid).toBe(first.data.pid);
    expect(writer.session).not.toBe(first.session);
    expect(writer.data.pid).not.toBe(first.data.pid);
    expect(writer.data.calls).toBe(1);
    expect(JSON.stringify(second.data.context)).toContain("first private input");
    expect(JSON.stringify(writer.data.context)).not.toContain("first private input");
    expect(second.data.env).not.toContain("SYNTHETIC_SLACK_SECRET");
    expect(second.data.env).not.toContain("HOME");
  } finally {
    delete process.env.SYNTHETIC_SLACK_SECRET;
  }
}, 15000);
it("worker loss keeps input; explicit recovery resumes the same logical session", async () => {
  let failures = true;
  const {
    store,
    collaboration: c,
    supervisor,
    work,
  } = setup(() =>
    failures
      ? {
          run: async () => {
            throw new Error("killed");
          },
          close: () => {},
        }
      : new WorkerClient(
          "test",
          "test",
          "key",
          new URL("../../dist/tests/helpers/worker-fixture.js", import.meta.url),
        ),
  );
  const delivery = c.enqueue("research", work, "one", { text: "recover me" });
  await supervisor.step("research");
  expect(store.delivery(delivery).status).toBe("injected");
  store.resume("research");
  failures = false;
  await supervisor.step("research");
  expect(store.delivery(delivery).status).toBe("handled");
  expect(JSON.stringify(last(store, "research").data.context)).toContain("recover me");
}, 10000);
it("local tools use immutable receipts and can claim another visible activity", async () => {
  const { store, collaboration: c, work, router } = setup();
  c.enqueue("research", work, "one", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  const target = fixtureTarget("CTEST", "100.000001"),
    signal = new AbortController().signal;
  const created = await router.call(
    run,
    work,
    "create",
    "tasks.create",
    { target, title: "one" },
    signal,
  );
  expect(
    await router.call(run, work, "create", "tasks.create", { target, title: "one" }, signal),
  ).toEqual(created);
  expect(c.list("research")).toHaveLength(1);
  const other = c.createWork("human:other", target),
    task = anchoredTask(c, "research", other, target, "other");
  const held = (
    await router.call(
      run,
      work,
      "claim",
      "tasks.claim",
      { taskId: task, expectedVersion: 0 },
      signal,
    )
  ).value as any;
  expect(c.task(task).owner).toBeNull();
  await router.call(
    run,
    work,
    "continue-claim",
    "tasks.continue",
    {
      intentId: held.intentId,
      holdId: held.holdId,
      acknowledge: "apply_despite_unread_or_changes",
    },
    signal,
  );
  expect(c.task(task).owner).toBe("research");
  await expect(
    router.call(
      run,
      work,
      "spoof",
      "messages.send",
      { target, text: "hi", agentId: "writer" },
      signal,
    ),
  ).rejects.toThrow();
});
it("recovery is bounded even with large task results; memory callback is injected and hashed", async () => {
  let seen: import("../../src/runtime/engine.js").RunSpec | undefined;
  const { store, collaboration: c, work, router, config, supervisor: original } = setup();
  original.close();
  const supervisor = new Supervisor(
    c,
    router,
    config,
    () => ({
      run: async (spec) => {
        seen = spec;
        return { tokens: 0, cost: 0, certain: true, waiting: false, continuation: false };
      },
      close: () => {},
    }),
    async () => "私有memory".repeat(10000),
  );
  cleanups.unshift(() => supervisor.close());
  for (let n = 0; n < 3; n++) {
    const task = anchoredTask(c, "research", work, fixtureTarget("CTEST", "100.000001"), "big");
    c.claim("research", task);
    c.update("research", task, "review", "x".repeat(35000));
  }
  c.enqueue("research", work, "large", {});
  await supervisor.step("research");
  expect(Buffer.byteLength(seen!.recovery)).toBeLessThan(15000);
  expect(JSON.parse(seen!.recovery).memoryNeedsOrganization).toBe(true);
  expect(JSON.parse(seen!.recovery).memory).toContain("私有memory");
  expect(
    store.db.prepare("SELECT count(*) n FROM audit WHERE kind='context_restore'").get(),
  ).toEqual({ n: 1 });
});
it("inbox list/read show own durable deliveries without revealing a revoked channel", async () => {
  const { store, collaboration: c, work, router } = setup();
  const first = c.enqueue("research", work, "first", { kind: "notice" });
  const run = store.beginRun("research")!;
  store.input(run, {});
  const secret = c.enqueue("research", work, "secret", {
    target: fixtureTarget("CTWO", "100.000001"),
    text: "private",
  });
  c.messages.membership("research", "CTWO", false);
  const signal = new AbortController().signal;
  const listed = ((await router.call(run, work, "list", "inbox.list", {}, signal)).value ?? []) as {
    id: string;
    status: string;
    kind?: string;
  }[];
  expect(listed).toContainEqual({ id: first, status: "injected", kind: "notice" });
  expect(listed.map((delivery) => delivery.id)).not.toContain(secret);
  await expect(
    router.call(run, work, "read", "inbox.read", { deliveryId: secret }, signal),
  ).rejects.toThrow();
  // A stored payload whose target names no conversation is refused, not read with no access check
  // at all. This release's own writer validates targets, so only an outside writer could store it.
  const malformed = "malformed-delivery";
  store.db
    .prepare(
      "INSERT INTO deliveries(id,agent_id,dedupe,payload,priority,created_at) VALUES(?,?,?,?,?,?)",
    )
    .run(
      malformed,
      "research",
      "malformed",
      JSON.stringify({ kind: "notice", target: { threadId: "not-a-conversation" } }),
      50,
      Date.now(),
    );
  expect(
    (
      ((await router.call(run, work, "list-after", "inbox.list", {}, signal)).value ?? []) as {
        id: string;
      }[]
    ).map((delivery) => delivery.id),
  ).not.toContain(malformed);
  await expect(
    router.call(run, work, "read-malformed", "inbox.read", { deliveryId: malformed }, signal),
  ).rejects.toThrow("not a conversation");
  expect(
    (await router.call(run, work, "read", "inbox.read", { deliveryId: first }, signal)).value,
  ).toMatchObject({ id: first, agent_id: "research", payload: { kind: "notice" } });
  // Reading the inbox observes the delivery; the scheduler still owns its own status.
  expect(store.delivery(first).status).toBe("injected");
});
it("invalid run IPC fails immediately instead of consuming the run timeout", async () => {
  const worker = new WorkerClient(
    "test",
    "test",
    "key",
    new URL("../../dist/tests/helpers/worker-fixture.js", import.meta.url),
  );
  try {
    await expect(
      worker.run(
        { sessionId: "s", messages: [], recovery: "x".repeat(50001), maxTurns: 1 },
        { journal: async () => {}, tool: async () => ({ value: null }) },
        10000,
        new AbortController().signal,
      ),
    ).rejects.toThrow("Invalid worker run payload");
  } finally {
    worker.close();
  }
}, 2000);
it("crash after effect commit before tool-result journal restores its receipt without re-execution", async () => {
  const { answer } = await import("../helpers/pi.js");
  let first = true,
    restored = "";
  const {
    store,
    collaboration: c,
    work,
    supervisor,
  } = setup(() => ({
    close: () => {},
    run: async (spec, hooks) => {
      if (first) {
        first = false;
        await hooks.journal(
          answer(
            [
              {
                type: "toolCall",
                id: "create-committed",
                name: "mate",
                arguments: {
                  operation: "tasks.create",
                  args: {
                    target: fixtureTarget("CTEST", "100.000001"),
                    title: "commit before crash",
                  },
                },
              },
            ],
            "toolUse",
          ),
        );
        await hooks.tool("create-committed", "tasks.create", {
          target: fixtureTarget("CTEST", "100.000001"),
          title: "commit before crash",
        });
        throw new Error("kill before result journal");
      }
      restored = JSON.stringify(spec.messages);
      return { tokens: 0, cost: 0, certain: true, waiting: false, continuation: false };
    },
  }));
  c.enqueue("research", work, "crash-window", {});
  await supervisor.step("research");
  expect(c.list("research")).toHaveLength(1);
  store.resume("research");
  await supervisor.step("research");
  expect(c.list("research")).toHaveLength(1);
  expect(restored).toContain("recoveredAction");
  expect(restored).toContain("succeeded");
  expect(restored).toContain("Historical receipt");
});
it("switching activity retains run ownership and stop targets the selected activity", async () => {
  const { store, collaboration: c, work, router } = setup();
  const other = c.createWork("other", { conversationId: "CTWO" });
  c.enqueue("research", work, "one", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  c.bindRunWork(run, work);
  await router.call(
    run,
    work,
    "switch",
    "works.select",
    { workId: other },
    new AbortController().signal,
  );
  await router.call(
    run,
    work,
    "create",
    "tasks.create",
    { target: { conversationId: "CTWO" }, title: "new context" },
    new AbortController().signal,
  );
  expect(c.list("research")[0]?.work_id).toBe(other);
  expect(c.control("UOWNER", work, "pause")).toEqual([]);
  expect(c.control("UOWNER", other, "pause")).toEqual([run.id]);
});
it("work selection is idempotent without quota columns", async () => {
  const { store, collaboration: c, work, router } = setup();
  const other = c.createWork("other", { conversationId: "CTWO" });
  c.enqueue("research", work, "one", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  c.bindRunWork(run, work);
  const signal = new AbortController().signal;
  const first = await router.call(run, work, "switch", "works.select", { workId: other }, signal);
  expect(await router.call(run, work, "switch", "works.select", { workId: other }, signal)).toEqual(
    first,
  );
  expect(
    store.db.prepare("SELECT 1 FROM pragma_table_info('works') WHERE name='max_tokens'").get(),
  ).toBeUndefined();
  expect(c.currentWork(run, work)).toBe(other);
});
it("attributes each model call to the activity selected when that call begins", async () => {
  const { answer } = await import("../helpers/pi.js");
  const { store, collaboration: c, work, supervisor: original, router } = setup();
  original.close();
  const other = c.createWork("other", { conversationId: "CTWO" });
  const supervisor = new Supervisor(c, router, { runTimeoutMs: 10000 }, () => ({
    close() {},
    async run(_spec, hooks) {
      await hooks.usageBegin?.(1, "openai", "synthetic");
      await hooks.usageComplete?.(1, answer([]));
      await hooks.tool("select-work", "works.select", { workId: other });
      await hooks.usageBegin?.(2, "openai", "synthetic");
      await hooks.usageComplete?.(2, answer([]));
      return { tokens: 24, cost: 0, certain: true, waiting: false, continuation: false };
    },
  }));
  cleanups.unshift(() => supervisor.close());
  c.enqueue("research", work, "two-model-calls", {});
  await supervisor.step("research");
  expect(
    store.db.prepare("SELECT call_index,work_id FROM model_usage ORDER BY call_index").all(),
  ).toEqual([
    { call_index: 1, work_id: work },
    { call_index: 2, work_id: other },
  ]);
});
it("runs a reminder firing for its author and attributes its model usage to them and the work item", async () => {
  const { answer } = await import("../helpers/pi.js");
  const { store, collaboration: c, supervisor: original, router } = setup();
  original.close();
  // The reminder belongs to its author's own work item, which no run selected.
  const reminderWork = c.createWork("reminder-source", { conversationId: "CTWO" });
  const reminder = c.reminders.create("research", reminderWork, {
    target: { conversationId: "CTWO" },
    content: "check the promised follow-up",
    nextAt: 1,
    timezone: "UTC",
  });
  c.tick(2);
  const supervisor = new Supervisor(c, router, { runTimeoutMs: 10000 }, () => ({
    close() {},
    async run(_spec, hooks) {
      await hooks.usageBegin?.(1, "openai", "synthetic");
      await hooks.usageComplete?.(1, answer([]));
      return { tokens: 24, cost: 0, certain: true, waiting: false, continuation: false };
    },
  }));
  cleanups.unshift(() => supervisor.close());
  const deliveries = store.db.prepare("SELECT id,agent_id FROM deliveries").all() as {
    id: string;
    agent_id: string;
  }[];
  expect(deliveries).toEqual([{ id: expect.any(String), agent_id: "research" }]);
  expect(
    store.db
      .prepare("SELECT work_id FROM delivery_work WHERE delivery_id=?")
      .get(deliveries[0]!.id),
  ).toEqual({ work_id: reminderWork });
  await supervisor.step("research");
  expect(store.db.prepare("SELECT agent_id,work_id FROM model_usage").all()).toEqual([
    { agent_id: "research", work_id: reminderWork },
  ]);
  expect(reminder.agent_id).toBe("research");
});
it("selected activity survives interrupted delivery recovery while its origin is paused", () => {
  const { store, collaboration: c, work } = setup();
  const other = c.createWork("other", { conversationId: "CTWO" });
  c.enqueue("research", work, "one", {});
  const first = store.beginRun("research")!;
  store.input(first, {});
  c.bindRunWork(first, work);
  c.selectWork(first, other);
  c.control("UOWNER", work, "pause");
  store.recover();
  const next = store.beginRun("research", Date.now(), true)!;
  expect(next).toBeDefined();
  c.bindRunWork(next, other);
  expect(c.currentWork(next, work)).toBe(other);
});
it("cached attention.read rechecks current membership even with an expired presentation epoch", async () => {
  const { store, collaboration: c, router, work } = setup();
  c.enqueue("research", work, "start", {});
  const run = store.beginRun("research")!;
  const args = { target: { conversationId: "CTEST" } },
    signal = new AbortController().signal;
  await router.call(run, work, "read", "attention.read", args, signal);
  c.attention.invalidate(run.sessionId);
  c.messages.membership("research", "CTEST", false);
  await expect(router.call(run, work, "read", "attention.read", args, signal)).rejects.toThrow(
    "access",
  );
});
it("fresh review seat withholds bodies through tools, notice, recovery and held feedback while allowing an independent submission", async () => {
  let captured = "";
  const {
    store,
    collaboration: c,
    work,
    router,
    supervisor,
  } = setup(() => ({
    close: () => {},
    run: async (spec, hooks) => {
      captured = JSON.stringify(spec);
      captured += await hooks.notice?.();
      return { tokens: 1, cost: 0, certain: true, waiting: false, continuation: false };
    },
  }));
  const target = fixtureTarget("CTEST", "100.000001");
  c.messages.record(
    {
      id: target.threadId,
      conversationId: target.conversationId,
      rootId: target.threadId,
      order: "100000001",
      revision: "100000001",
      text: "WITHHELD_PEER_CONCLUSION",
      author: { kind: "agent", id: "writer" },
      origin: "participant",
      mentions: [],
      attachments: [],
      deleted: false,
    },
    ["research"],
  );
  c.seats.activate(
    "UOWNER",
    "research",
    target,
    "Independently compute 2+2; submit result.",
    () => "/synthetic/clean-review-root",
  );
  const delivery = c.enqueue("research", work, "review", {
    text: "WITHHELD_PEER_CONCLUSION",
    source: { id: "UTWO" },
    target,
  });
  store.db.prepare("UPDATE deliveries SET created_at=1234567890000 WHERE id=?").run(delivery);
  await supervisor.step("research");
  expect(captured).toContain("Independently compute");
  expect(captured).not.toContain("WITHHELD_PEER_CONCLUSION");
  expect(captured).not.toContain("UTWO");
  expect(captured).not.toContain("1234567890000");
  const session = (
    store.db.prepare("SELECT session_id FROM agents WHERE id='research'").get() as {
      session_id: string;
    }
  ).session_id;
  expect(JSON.stringify(store.context(session))).not.toContain("1234567890000");
  c.enqueue("research", work, "tools", {});
  const run = store.beginRun("research")!;
  const signal = new AbortController().signal;
  for (const [op, args] of [
    ["attention.read", { target }],
    ["inbox.list", {}],
    ["tasks.list", {}],
    ["conversations.members", { conversationId: "CTEST" }],
    ["attachments.save", { message: { messageId: "M1" }, fileId: "F1", path: "brief.txt" }],
  ] as const)
    await expect(router.call(run, work, op, op, args, signal)).rejects.toThrow("isolates");
  // The retired bulk reads left the model entry surface, so no seat policy can reach them.
  for (const op of ["messages.recent", "messages.read", "messages.search"] as const)
    await expect(router.call(run, work, op, op, {}, signal)).rejects.toThrow("Unknown operation");
  const result = await router.call(
    run,
    work,
    "send",
    "messages.send",
    { target, text: "My independent result is 4" },
    signal,
  );
  const held = result.value as any;
  expect(held.status).toBe("held");
  expect(JSON.stringify(held)).not.toContain("WITHHELD");
  await router.call(
    run,
    work,
    "continue",
    "drafts.continue",
    {
      draftId: held.draftId,
      revision: held.revision,
      holdId: held.holdId,
      acknowledge: "send_despite_unread_or_changes",
    },
    signal,
  );
  await c.output.send(held.draftId);
  expect(store.output(held.draftId)?.state).toBe("sent");
  expect(store.db.prepare("SELECT count(*) n FROM attention_seen").get()).toEqual({ n: 0 });
});
it("review activation cannot wash an already used identity or accept an unverified workspace", () => {
  const { store, collaboration: c, work } = setup();
  const target = { conversationId: "CTEST" };
  expect(() => c.seats.activate("UTWO", "research", target, "brief", () => "/clean")).toThrow(
    "Owner",
  );
  expect(() =>
    c.seats.activate("UOWNER", "research", target, "brief", () => {
      throw new Error("dirty workspace");
    }),
  ).toThrow("dirty");
  c.enqueue("research", work, "used", {});
  store.beginRun("research");
  expect(() => c.seats.activate("UOWNER", "research", target, "brief", () => "/clean")).toThrow(
    "unused",
  );
});

it("discovery aliases expose grant-free file tools and reject actor spoofing", async () => {
  const { store, collaboration: c, work, router } = setup();
  c.enqueue("research", work, "files", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  const signal = new AbortController().signal;
  const list = await router.call(run, work, "list-tools", "tools.list", {}, signal);
  expect(JSON.stringify(list)).toContain("file.edit");
  const schema = await router.call(
    run,
    work,
    "schema",
    "tools.describe",
    { name: "file.edit" },
    signal,
  );
  expect(JSON.stringify(schema)).toContain("expectedHash");
  expect(
    (
      await router.call(
        run,
        work,
        "read",
        "tools.call",
        { name: "file.list", input: { path: "." } },
        signal,
      )
    ).value,
  ).toMatchObject({ code: 0 });
  await expect(
    router.call(
      run,
      work,
      "spoof",
      "tools.call",
      { name: "file.list", input: { path: ".", agentId: "writer" } },
      signal,
    ),
  ).rejects.toThrow();
  await expect(
    router.call(run, work, "recurse", "tools.call", { name: "tools.call", input: {} }, signal),
  ).rejects.toThrow("Unknown");
});
it("model context replacement waits for run completion and retains durable identity", async () => {
  let created = 0,
    closed = 0,
    first = true;
  let restored = "";
  const {
    store,
    collaboration: c,
    work,
    supervisor,
    router,
  } = setup(() => {
    created++;
    return {
      close: () => {
        closed++;
      },
      run: async (spec, hooks) => {
        if (first) {
          first = false;
          expect(
            (
              await hooks.tool("reset", "sessions.reset", {
                text: "Continue independent research; inspect unknown receipts.",
              })
            ).wait,
          ).toBe(true);
        } else restored = JSON.stringify(spec.messages);
        return { tokens: 12, cost: 0.01, certain: true, waiting: true, continuation: false };
      },
    };
  });
  const before = (router.sessions.status("research") as any).session,
    peer = (router.sessions.status("writer") as any).session;
  const task = anchoredTask(c, "research", work, { conversationId: "CTEST" }, "durable task");
  const reminder = c.reminders.create("research", work, {
    target: { conversationId: "CTEST" },
    content: "later",
    nextAt: Date.now() + 100000,
    timezone: "UTC",
  });
  c.enqueue("research", work, "reset-one", {});
  await supervisor.step("research");
  expect((router.sessions.status("research") as any).session).not.toBe(before);
  expect((router.sessions.status("writer") as any).session).toBe(peer);
  expect(c.task(task).title).toBe("durable task");
  expect(c.reminders.read("research", reminder.id)).toBeDefined();
  expect(closed).toBe(1);
  await supervisor.step("research");
  expect(created).toBe(2);
  expect(restored).toContain("Continue independent research");
  expect(store.db.prepare("SELECT count(*) n FROM session_resets").get()).toEqual({ n: 1 });
});
it("crash recovery applies a requested reset exactly once without erasing unknown actions or bypassing paused work", async () => {
  const { store, collaboration: c, work, supervisor, router } = setup();
  c.enqueue("research", work, "reset-crash", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  c.bindRunWork(run, work);
  store.prepareAction(run, "uncertain", { synthetic: true });
  store.startAction(run, "uncertain");
  const reply = await router.call(
    run,
    work,
    "reset",
    "sessions.reset",
    { text: "recover carefully" },
    new AbortController().signal,
  );
  expect(reply.wait).toBe(true);
  expect(router.sessions.apply("research")).toBe(false);
  store.db.prepare("UPDATE works SET state='paused' WHERE id=?").run(work);
  store.recover();
  supervisor.recoverSessions();
  const session = (router.sessions.status("research") as any).session;
  supervisor.recoverSessions();
  expect((router.sessions.status("research") as any).session).toBe(session);
  expect(session).not.toBe(run.sessionId);
  expect(store.action("uncertain")?.state).toBe("unknown");
  expect(store.beginRun("research", Date.now(), true)).toBeUndefined();
  expect(
    store.db.prepare("SELECT count(*) n FROM deliveries WHERE dedupe LIKE 'session-reset:%'").get(),
  ).toEqual({ n: 1 });
});
it("owner reset is owner-only, invalidates old views and leaves the Agent paused", async () => {
  const { Controls } = await import("../../src/daemon/control.js");
  const { store, collaboration: c, work, supervisor, router } = setup();
  const controls = new Controls(c, supervisor, router.broker);
  c.enqueue("research", work, "owner-reset", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  const epoch = (
    store.db.prepare("SELECT context_epoch FROM sessions WHERE id=?").get(run.sessionId) as any
  ).context_epoch;
  await expect(
    router.call(
      run,
      work,
      "spoof-reset",
      "sessions.reset",
      { text: "x", agentId: "writer" },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(() => controls.execute("UTWO", "agent-reset research checkpoint")).toThrow("Owner");
  expect(controls.execute("UOWNER", "agent-reset research keep going")).toContain("paused");
  expect(store.beginRun("research")).toBeUndefined();
  expect(
    (store.db.prepare("SELECT context_epoch FROM sessions WHERE id=?").get(run.sessionId) as any)
      .context_epoch,
  ).toBeGreaterThan(epoch);
  expect(
    JSON.stringify(store.context((router.sessions.status("research") as any).session)),
  ).toContain("keep going");
});
it("new contexts can discover and inspect their own old uncertain execution without replay or peer leakage", async () => {
  const { store, collaboration: c, work, router, supervisor } = setup();
  c.enqueue("research", work, "receipt-reset", {});
  const old = store.beginRun("research")!;
  store.input(old, {});
  store.prepareAction(old, "OLD-EXEC", {
    workId: work,
    operation: { kind: "exec", command: "synthetic-command" },
    root: "/private",
  });
  store.startAction(old, "OLD-EXEC");
  await router.call(
    old,
    work,
    "reset",
    "sessions.reset",
    { text: "continue" },
    new AbortController().signal,
  );
  store.recover();
  supervisor.recoverSessions();
  const next = store.beginRun("research", Date.now(), true)!;
  store.input(next, {});
  const signal = new AbortController().signal;
  const list = await router.call(next, work, "list", "actions.list", {}, signal);
  expect(JSON.stringify(list)).toContain("OLD-EXEC");
  expect(JSON.stringify(list)).not.toContain("synthetic-command");
  const read = await router.call(
    next,
    work,
    "read",
    "actions.read",
    { actionId: "OLD-EXEC" },
    signal,
  );
  expect(read.value).toMatchObject({
    state: "unknown",
    request: { operation: { command: "synthetic-command" } },
  });
  c.enqueue("writer", work, "other", {});
  const peer = store.beginRun("writer")!;
  store.input(peer, {});
  await expect(
    router.call(peer, work, "read", "actions.read", { actionId: "OLD-EXEC" }, signal),
  ).rejects.toThrow("own action");
  c.messages.membership("research", "CTEST", false);
  expect(
    (await router.call(next, work, "read2", "actions.read", { actionId: "OLD-EXEC" }, signal))
      .value,
  ).toMatchObject({ state: "unknown", request: { operation: { command: "synthetic-command" } } });
});
it("historical non-execution receipts cannot bypass current object ACL through indirect references", async () => {
  const { store, collaboration: c, work, router } = setup();
  c.enqueue("research", work, "historical-acl", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  const reminder = c.reminders.create("research", work, {
    target: { conversationId: "CTWO" },
    content: "WITHHELD_HISTORY",
    nextAt: Date.now() + 10000,
    timezone: "UTC",
  });
  const signal = new AbortController().signal;
  await router.call(
    run,
    work,
    "cancel-history",
    "reminders.cancel",
    { reminderId: reminder.id, expectedVersion: 1 },
    signal,
  );
  c.messages.membership("research", "CTWO", false);
  await expect(
    router.call(run, work, "read-reminder", "reminders.read", { reminderId: reminder.id }, signal),
  ).rejects.toThrow("access");
  const result = await router.call(
    run,
    work,
    "read-history",
    "actions.read",
    { actionId: run.sessionId + ":cancel-history" },
    signal,
  );
  expect(JSON.stringify(result)).not.toContain("WITHHELD_HISTORY");
  expect(JSON.stringify(result)).toContain("receiptUnavailable");
});
it("recovery refresh rereads memory, the latest checkpoint and the selected work", async () => {
  const { store, collaboration: c, work, router, config, supervisor: original } = setup();
  original.close();
  let memory = "old knowledge",
    fresh: any;
  const other = c.createWork("fresh-work", { conversationId: "CTWO" });
  let reads = 0;
  const supervisor = new Supervisor(
    c,
    router,
    config,
    () => ({
      close: () => {},
      run: async (spec, hooks) => {
        expect(JSON.parse(spec.recovery).memory).toBe("old knowledge");
        await hooks.tool("select", "works.select", { workId: other });
        await hooks.tool("checkpoint", "sessions.checkpoint", { text: "updated active context" });
        memory = "new domain knowledge";
        fresh = JSON.parse(await hooks.refreshRecovery!());
        return { tokens: 5, cost: 0, certain: true, waiting: false, continuation: false };
      },
    }),
    async () => {
      reads++;
      return memory;
    },
  );
  cleanups.unshift(() => supervisor.close());
  c.enqueue("research", work, "refresh-memory", {});
  await supervisor.step("research");
  expect(reads).toBe(2);
  expect(fresh.memory).toBe("new domain knowledge");
  expect(fresh.checkpoint.text).toBe("updated active context");
  expect(fresh.work.id).toBe(other);
  expect(fresh.usage.knownCalls).toBe(0);
  expect(
    store.db.prepare("SELECT count(*) n FROM audit WHERE kind='recovery_refresh'").get(),
  ).toEqual({ n: 2 });
});

it("worker factories receive platform-independent definitions through the member directory", async () => {
  const f = setup();
  let received: unknown;
  const supervisor = new Supervisor(
    f.collaboration,
    f.router,
    { runTimeoutMs: f.config.runTimeoutMs },
    (definition) => {
      received = definition;
      return {
        run: async () => ({
          certain: true,
          tokens: 1,
          cost: 0,
          continuation: false,
          waiting: false,
        }),
        close() {},
      };
    },
  );
  try {
    f.collaboration.enqueue("research", f.work, "independent-definition", {});
    await supervisor.step("research");
    expect(received).toEqual({
      id: "research",
      name: "Research",
      role: "Find evidence",
      model: f.config.agents[0]!.model,
    });
    expect(received).not.toHaveProperty("slackAppId");
    expect(received).not.toHaveProperty("botTokenEnv");
  } finally {
    supervisor.close();
  }
});
