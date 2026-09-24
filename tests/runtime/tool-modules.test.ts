import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../../src/storage/store.js";
import { configSchema } from "../../src/config.js";
import { configFixture } from "../helpers/config.js";
import { Messages, Output, migrateCurrentRuntime } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { Broker } from "../../src/policy/broker.js";
import {
  ToolRouter,
  builtInToolSpecs,
  fingerprintToolSpecs,
  operationContractFingerprint,
  operationDocumentation,
  validateToolModules,
  type ToolModule,
} from "../../src/runtime/tools.js";
import { fixtureTarget } from "../helpers/canonical-slack.js";
import type { ConversationDirectory } from "../../src/conversations/directory.js";
import { buildBaseline } from "../../src/runtime/prompt.js";
import { environmentReportSchema } from "../../src/capabilities/environment.js";
import { ProcessNotRunningError } from "../../src/execution/linux-processes.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function setup(directory?: ConversationDirectory) {
  const config = configSchema.parse(configFixture),
    store = new Store(":memory:");
  stores.push(store);
  const messages = new Messages(store, config);
  migrateCurrentRuntime(store);
  const c = new Collaboration(
      store,
      messages,
      new Output(messages, { post: async () => ({ ts: "200.000001" }) }),
      config,
    ),
    broker = new Broker(
      store,
      c,
      {
        execute: async () => ({
          code: 0,
          stdout: "",
          stderr: "",
          truncated: false,
        }),
      },
      {},
    );
  store.register("research", "v1", []);
  messages.membership("research", "CTEST", true);
  const work = c.createWork("tools", fixtureTarget("CTEST", "100.000001"));
  c.enqueue("research", work, "start", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  return {
    store,
    c,
    work,
    run,
    router: new ToolRouter(c, broker, undefined, directory),
    broker,
  };
}
const expected = `
history.page history.search history.around history.fetch
conversations.capabilities conversations.discover conversations.join conversations.leave conversations.refresh conversations.list conversations.members conversations.openDM
attention.peek attention.read attention.resolve attention.defer attention.mute
messages.recent messages.read messages.search messages.send messages.watch inbox.list inbox.read inbox.ack
works.list works.select tasks.list tasks.read tasks.events tasks.byMessage tasks.intents tasks.retry tasks.continue tasks.discard tasks.create tasks.claim tasks.unclaim tasks.transfer tasks.wait tasks.update tasks.delegate
reminders.list reminders.read reminders.log reminders.finish reminders.create reminders.edit reminders.cancel schedules.list schedules.create schedules.cancel
actions.list actions.read sessions.status sessions.checkpoint sessions.reset environment.info usage.read agents drafts.list drafts.read drafts.retry drafts.continue drafts.revise drafts.discard
file.read_bytes file.write_bytes file.read file.write file.list file.stat file.search file.mkdir file.move file.remove file.edit exec processes.list processes.stop system.request system.status attachments.save research.read artifact.publish artifact.revise`
  .trim()
  .split(/\s+/);

it("registers every public operation exactly once with complete policies and stable documentation order", async () => {
  expect(builtInToolSpecs.map((entry) => entry.name)).toEqual(expected);
  expect(new Set(expected).size).toBe(expected.length);
  expect(Object.isFrozen(builtInToolSpecs)).toBe(true);
  expect(operationContractFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const allowed = {
    work: ["none", "current", "task", "reminder", "select", "broker-managed"],
    seat: ["deny", "redacted-read", "clean-workspace", "held-send"],
    effect: ["pure-read", "atomic-recorded", "broker-recorded", "adapter-recorded"],
    replay: ["immutable", "refreshable", "boundary-owned"],
  };
  for (const entry of builtInToolSpecs) {
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.description.length).toBeGreaterThan(10);
    expect(typeof entry.schema.parse).toBe("function");
    expect(allowed.work).toContain(entry.workPolicy);
    expect(allowed.seat).toContain(entry.seatPolicy);
    expect(allowed.effect).toContain(entry.effectPolicy);
    expect(allowed.replay).toContain(entry.replayPolicy);
    expect(typeof entry.authorize).toBe("function");
    expect(typeof entry.postAwait).toBe("function");
    expect(typeof entry.handler).toBe("function");
  }
  expect(operationDocumentation).toContain(`Tool contract: ${operationContractFingerprint}`);
  expect(operationDocumentation.match(/Available: (.*)\.\n/)?.[1]?.split(", ")).toEqual(expected);
  const changed = fingerprintToolSpecs([
    {
      ...builtInToolSpecs[0]!,
      description: builtInToolSpecs[0]!.description + " changed",
    },
    ...builtInToolSpecs.slice(1),
  ] as any);
  expect(changed).not.toBe(operationContractFingerprint);
  const agent = configSchema.parse(configFixture).agents[0]!;
  expect(
    buildBaseline(agent, operationDocumentation.replace(operationContractFingerprint, changed))
      .configVersion,
  ).not.toBe(buildBaseline(agent, operationDocumentation).configVersion);
  const { router, run, work } = setup(),
    listed = (await router.call(run, work, "list", "tools.list", {}, new AbortController().signal))
      .value as { name: string }[];
  expect(listed.map((item) => item.name)).toEqual(expected);
  for (const name of expected) {
    const described = (
      await router.call(
        run,
        work,
        `describe-${name}`,
        "tools.describe",
        { name },
        new AbortController().signal,
      )
    ).value as any;
    expect(described.name).toBe(name);
    expect(described.inputSchema).toHaveProperty("$schema");
  }
});

it("fails closed for duplicate, reserved, incomplete and unknown module specifications", () => {
  setup();
  const base = builtInToolSpecs[0]!;
  const build = (modules: ToolModule[]) => validateToolModules(modules);
  expect(() => build([{ domain: "x", specs: [base, base] }])).toThrow(/duplicate/);
  expect(() => build([{ domain: "x", specs: [{ ...base, name: "tools.escape" }] }])).toThrow(
    /reserved/,
  );
  expect(() => build([{ domain: "x", specs: [{ ...base, authorize: undefined } as any] }])).toThrow(
    /Incomplete/,
  );
  expect(() =>
    build([{ domain: "x", specs: [{ ...base, workPolicy: "ambient" } as any] }]),
  ).toThrow(/unknown/);
  expect(() =>
    build([
      {
        domain: "x",
        specs: [{ ...base, effectPolicy: "atomic-recorded" } as any],
      },
    ]),
  ).toThrow(/effect/);
  expect(() => build([{ domain: "x", specs: [] }])).toThrow(/module/);
});

it("preserves immutable and refreshable replay while unknown or executing calls never dispatch", async () => {
  const { router, run, work, store } = setup(),
    signal = new AbortController().signal;
  const checkpoint = await router.call(
    run,
    work,
    "checkpoint",
    "sessions.checkpoint",
    { text: "first" },
    signal,
  );
  expect((checkpoint.value as any).checkpoint.text).toBe("first");
  expect(
    await router.call(run, work, "checkpoint", "sessions.checkpoint", { text: "first" }, signal),
  ).toEqual(checkpoint);
  await expect(
    router.call(run, work, "checkpoint", "sessions.checkpoint", { text: "changed" }, signal),
  ).rejects.toThrow(/identity conflict/);
  expect((router.sessions.status("research") as any).checkpoint.text).toBe("first");
  expect(
    ((await router.call(run, work, "status", "sessions.status", {}, signal)).value as any)
      .checkpoint.text,
  ).toBe("first");
  store.db.prepare("UPDATE agent_checkpoints SET text='fresh' WHERE agent_id='research'").run();
  expect(
    ((await router.call(run, work, "status", "sessions.status", {}, signal)).value as any)
      .checkpoint.text,
  ).toBe("fresh");
  const before = (store.db.prepare("SELECT count(*) n FROM actions").get() as { n: number }).n;
  await expect(router.call(run, work, "unknown", "missing.operation", {}, signal)).rejects.toThrow(
    "Unknown operation",
  );
  expect((store.db.prepare("SELECT count(*) n FROM actions").get() as { n: number }).n).toBe(
    before,
  );
  const args = {
      target: fixtureTarget("CTEST", "100.000001"),
      title: "must not appear",
    },
    actionId = `${run.sessionId}:busy`;
  store.prepareAction(run, actionId, {
    workId: work,
    operation: "tasks.create",
    args,
  });
  store.startAction(run, actionId);
  await expect(router.call(run, work, "busy", "tasks.create", args, signal)).rejects.toThrow(
    "Uncertain tool action",
  );
  expect((store.db.prepare("SELECT count(*) n FROM tasks").get() as { n: number }).n).toBe(0);
});

it("replays pre-module receipts with the original selected-work request identity", async () => {
  const { router, run, work, store, c } = setup(),
    other = c.createWork("other", { conversationId: "CTEST" }),
    taskId = c.createTask("research", other, { conversationId: "CTEST" }, "cross-work"),
    args = {
      taskId,
      expectedVersion: 0,
      status: "done" as const,
      result: "legacy",
    },
    actionId = `${run.sessionId}:legacy-cross-work`;
  store.prepareAction(run, actionId, {
    workId: work,
    operation: "tasks.update",
    args,
  });
  store.startAction(run, actionId);
  store.settleAction(run, actionId, "succeeded", {
    value: { legacyReceipt: true },
    wait: false,
  });
  await expect(
    router.call(run, work, "legacy-cross-work", "tasks.update", args, new AbortController().signal),
  ).resolves.toEqual({ value: { legacyReceipt: true }, wait: false });
  expect(c.task(taskId).status).toBe("todo");
});

it("authorizes task and reminder effects against their bound work while retaining legacy receipt identity", async () => {
  const { router, run, work, c, store } = setup(),
    other = c.createWork("other", { conversationId: "CTEST" }),
    taskId = c.createTask("research", other, { conversationId: "CTEST" }, "cross-work");
  c.claim("research", taskId);
  const signal = new AbortController().signal;
  const held = (
    await router.call(
      run,
      work,
      "cross-task",
      "tasks.update",
      {
        taskId,
        expectedVersion: c.task(taskId).version,
        status: "done",
        result: "evidence",
      },
      signal,
    )
  ).value as { intentId: string; holdId: string };
  expect(
    store.db
      .prepare("SELECT work_id FROM task_intents WHERE id=?")
      .get(`${run.sessionId}:cross-task`),
  ).toEqual({ work_id: other });
  const unrelated = c.createWork("unrelated", { conversationId: "CTEST" });
  c.selectWork(run, unrelated);
  await router.call(
    run,
    work,
    "continue-cross-task",
    "tasks.continue",
    {
      intentId: held.intentId,
      holdId: held.holdId,
      acknowledge: "apply_despite_unread_or_changes",
    },
    signal,
  );
  expect(c.task(taskId).status).toBe("done");
  const reminder = (
    await router.call(
      run,
      work,
      "cross-reminder",
      "reminders.create",
      {
        target: { conversationId: "CTEST" },
        content: "follow the task",
        nextAt: Date.now() + 10000,
        timezone: "UTC",
        taskId,
      },
      signal,
    )
  ).value as { work_id: string };
  expect(reminder.work_id).toBe(other);
  const request = JSON.parse((store.action(`${run.sessionId}:cross-reminder`) as any).request);
  expect(request.workId).toBe(unrelated);
});

it("binds canonical message claims to the existing task work instead of an unrelated selected work", async () => {
  const { router, run, work, c, store } = setup(),
    target = fixtureTarget("CTEST", "100.000001"),
    bound = c.createWork("bound-message", target),
    messageId = target.threadId!;
  c.messages.record(
    {
      id: messageId,
      conversationId: target.conversationId,
      rootId: messageId,
      order: "100000001",
      revision: "100000001",
      text: "claim this",
      author: { kind: "human", id: "UOWNER" },
      origin: "participant",
      mentions: [],
      attachments: [],
      deleted: false,
    },
    ["research"],
  );
  c.createTask("research", bound, target, "claim this", undefined, {
    messageKey: messageId,
  });
  const unrelated = c.createWork("unrelated-message", target);
  c.selectWork(run, unrelated);
  await expect(
    router.call(
      run,
      work,
      "claim-message",
      "tasks.claim",
      { message: { messageId }, expectedVersion: 0 },
      new AbortController().signal,
    ),
  ).resolves.toHaveProperty("value");
  expect(
    store.db
      .prepare("SELECT work_id FROM task_intents WHERE id=?")
      .get(`${run.sessionId}:claim-message`),
  ).toEqual({ work_id: bound });
});

it("applies post-await run fences while attention preferences remain available after work pauses", async () => {
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((resolve) => (started = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  const directory = {
    spaces: async () => {
      started();
      await gate;
      return { spaces: [], incomplete: false };
    },
  } as unknown as ConversationDirectory;
  const first = setup(directory),
    pending = first.router.call(
      first.run,
      first.work,
      "spaces",
      "conversations.list",
      {},
      new AbortController().signal,
    );
  await entered;
  first.store.finish(first.run);
  release();
  await expect(pending).rejects.toThrow(/run/i);
  const second = setup();
  second.store.db.prepare("UPDATE works SET state='paused' WHERE id=?").run(second.work);
  await expect(
    second.router.call(
      second.run,
      second.work,
      "watch",
      "messages.watch",
      { target: { conversationId: "CTEST" }, active: true },
      new AbortController().signal,
    ),
  ).resolves.toHaveProperty("value");
  await expect(
    second.router.call(
      second.run,
      second.work,
      "status",
      "sessions.status",
      {},
      new AbortController().signal,
    ),
  ).resolves.toHaveProperty("value");
});

it("uses one seat policy for direct calls, tools.call, list and describe", async () => {
  const { router, run, work, store } = setup();
  store.db
    .prepare("INSERT INTO review_seats VALUES(?,?,?,?,1)")
    .run("research", JSON.stringify({ conversationId: "CTEST" }), "brief", "/synthetic");
  const signal = new AbortController().signal;
  const names = (
    (await router.call(run, work, "list", "tools.list", {}, signal)).value as {
      name: string;
    }[]
  ).map((item) => item.name);
  expect(names).not.toContain("tasks.list");
  expect(names).toContain("messages.send");
  await expect(
    router.call(run, work, "describe-denied", "tools.describe", { name: "tasks.list" }, signal),
  ).rejects.toThrow(/isolates/);
  await expect(router.call(run, work, "direct-denied", "tasks.list", {}, signal)).rejects.toThrow(
    /isolates/,
  );
  await expect(
    router.call(run, work, "alias-denied", "tools.call", { name: "tasks.list", input: {} }, signal),
  ).rejects.toThrow(/isolates/);
  await expect(
    router.call(run, work, "describe-held", "tools.describe", { name: "messages.send" }, signal),
  ).resolves.toHaveProperty("value");
});

it("lets an Agent inspect and stop only its current Linux scope with a durable stop receipt", async () => {
  const base = setup(),
    unit = "mate-agent-1001-123e4567-e89b-42d3-a456-426614174000.scope";
  const list = vi.fn(() => [{ unit, pids: [4101] }]),
    stop = vi.fn(() => ({ unit, stopped: true }));
  const router = new ToolRouter(base.c, base.broker, {
      processes: { list, stop },
      research: async () => ({}),
      publish: async () => ({}),
    }),
    signal = new AbortController().signal;
  expect(
    (await router.call(base.run, base.work, "process-list", "processes.list", {}, signal)).value,
  ).toEqual([{ unit, pids: [4101] }]);
  const stopped = await router.call(
    base.run,
    base.work,
    "process-stop",
    "tools.call",
    { name: "processes.stop", input: { unit } },
    signal,
  );
  expect(stopped.value).toEqual({ unit, stopped: true });
  expect(stop).toHaveBeenCalledExactlyOnceWith("research", unit);
  expect(
    (await router.call(base.run, base.work, "process-stop", "processes.stop", { unit }, signal))
      .value,
  ).toMatchObject({ status: "succeeded", receipt: { unit, stopped: true } });
  expect(stop).toHaveBeenCalledTimes(1);
});

it("lets an Agent inspect and stop its Linux scope after the attributed work pauses", async () => {
  const base = setup(),
    unit = "mate-agent-1001-123e4567-e89b-42d3-a456-426614174000.scope";
  const stop = vi.fn(() => ({ unit, stopped: true }));
  const router = new ToolRouter(base.c, base.broker, {
    processes: { list: () => [{ unit, pids: [4101] }], stop },
    research: async () => ({}),
    publish: async () => ({}),
  });
  base.store.db.prepare("UPDATE works SET state='paused' WHERE id=?").run(base.work);
  const signal = new AbortController().signal;
  expect(
    (await router.call(base.run, base.work, "paused-list", "processes.list", {}, signal)).value,
  ).toEqual([{ unit, pids: [4101] }]);
  expect(
    (await router.call(base.run, base.work, "paused-stop", "processes.stop", { unit }, signal))
      .value,
  ).toEqual({ unit, stopped: true });
  expect(stop).toHaveBeenCalledOnce();
});

it("keeps private recovery and inbox acknowledgement available after work pauses", async () => {
  const base = setup(),
    signal = new AbortController().signal;
  base.store.db.prepare("UPDATE works SET state='paused' WHERE id=?").run(base.work);
  const checkpoint = await base.router.call(
    base.run,
    base.work,
    "paused-checkpoint",
    "sessions.checkpoint",
    { text: "Continue the user objective later." },
    signal,
  );
  expect(checkpoint.value).toMatchObject({
    checkpoint: { text: "Continue the user objective later." },
  });
  const acknowledged = await base.router.call(
    base.run,
    base.work,
    "paused-ack",
    "inbox.ack",
    { deliveryId: base.run.deliveryId },
    signal,
  );
  expect(acknowledged.value).toMatchObject({ id: base.run.deliveryId });
});

it("lets an Agent discard its own held output after the attributed work pauses", async () => {
  const base = setup(),
    signal = new AbortController().signal;
  const draft = (
    await base.router.call(
      base.run,
      base.work,
      "create-held",
      "messages.send",
      { target: { conversationId: "CTEST" }, text: "a proposed reply" },
      signal,
    )
  ).value as { draftId: string; revision: number; status: string };
  expect(draft.status).toBe("held");
  base.store.db.prepare("UPDATE works SET state='paused' WHERE id=?").run(base.work);
  const discarded = (
    await base.router.call(
      base.run,
      base.work,
      "discard-held",
      "drafts.discard",
      { draftId: draft.draftId, revision: draft.revision },
      signal,
    )
  ).value as { status: string };
  expect(discarded.status).toBe("failed");
});

it("lets an Agent revise and retain its held output after the attributed work pauses", async () => {
  const base = setup(),
    signal = new AbortController().signal;
  const draft = (
    await base.router.call(
      base.run,
      base.work,
      "create-revisable",
      "messages.send",
      { target: { conversationId: "CTEST" }, text: "initial proposal" },
      signal,
    )
  ).value as { draftId: string; revision: number; status: string };
  expect(draft.status).toBe("held");
  base.store.db.prepare("UPDATE works SET state='paused' WHERE id=?").run(base.work);
  const revised = (
    await base.router.call(
      base.run,
      base.work,
      "revise-held",
      "drafts.revise",
      {
        draftId: draft.draftId,
        revision: draft.revision,
        text: "revised proposal",
      },
      signal,
    )
  ).value as { text: string; status: string; revision: number };
  expect(revised).toMatchObject({
    text: "revised proposal",
    status: "held",
    revision: draft.revision + 1,
  });
  await expect(
    base.router.call(
      base.run,
      base.work,
      "retry-held",
      "drafts.retry",
      { draftId: draft.draftId, revision: revised.revision },
      signal,
    ),
  ).rejects.toThrow(/paused|cancelled/);
});

it("keeps an uncertain process-stop receipt when systemd cannot confirm cleanup", async () => {
  const base = setup(),
    unit = "mate-agent-1001-123e4567-e89b-42d3-a456-426614174000.scope";
  const stop = vi.fn(() => {
    throw new Error("systemd stop result unknown");
  });
  const router = new ToolRouter(base.c, base.broker, {
      processes: { list: () => [{ unit, pids: [4101] }], stop },
      research: async () => ({}),
      publish: async () => ({}),
    }),
    signal = new AbortController().signal;
  await expect(
    router.call(base.run, base.work, "stop-uncertain", "processes.stop", { unit }, signal),
  ).rejects.toThrow("systemd stop result unknown");
  expect(base.store.action(`${base.run.sessionId}:stop-uncertain`)?.state).toBe("unknown");
  expect(
    (await router.call(base.run, base.work, "stop-uncertain", "processes.stop", { unit }, signal))
      .value,
  ).toMatchObject({ status: "action_unknown" });
  expect(stop).toHaveBeenCalledTimes(1);
  expect(
    (await router.call(base.run, base.work, "list-after-uncertain", "processes.list", {}, signal))
      .value,
  ).toEqual([{ unit, pids: [4101] }]);
});

it("records a pre-stop refusal as failed without claiming an uncertain effect", async () => {
  const base = setup(),
    unit = "mate-agent-1001-123e4567-e89b-42d3-a456-426614174000.scope";
  const stop = vi.fn(() => {
    throw new ProcessNotRunningError("Agent scope is not running");
  });
  const router = new ToolRouter(base.c, base.broker, {
      processes: { list: () => [], stop },
      research: async () => ({}),
      publish: async () => ({}),
    }),
    signal = new AbortController().signal;
  await expect(
    router.call(base.run, base.work, "stop-missing", "processes.stop", { unit }, signal),
  ).rejects.toThrow("not running");
  expect(base.store.action(`${base.run.sessionId}:stop-missing`)?.state).toBe("failed");
  expect(
    (await router.call(base.run, base.work, "stop-missing", "processes.stop", { unit }, signal))
      .value,
  ).toMatchObject({
    status: "failed",
    receipt: { reason: "Agent scope is not running" },
  });
  expect(stop).toHaveBeenCalledTimes(1);
});

it("keeps known-URL research a receipt-free read and puts the reachable alternatives in the real baseline", async () => {
  const base = setup(),
    research = vi.fn(async (url: string) => ({
      url,
      body: "evidence",
      truncated: false,
    })),
    router = new ToolRouter(base.c, base.broker, {
      environment: () => ({}),
      research,
      publish: async () => ({}),
    }),
    signal = new AbortController().signal;
  const before = base.store.db.prepare("SELECT count(*) n FROM actions").get();
  const result = await router.call(
    base.run,
    base.work,
    "known-url",
    "research.read",
    { url: "https://example.com/source" },
    signal,
  );
  expect(result.value).toEqual({
    url: "https://example.com/source",
    body: "evidence",
    truncated: false,
  });
  expect(research).toHaveBeenCalledOnce();
  expect(base.store.db.prepare("SELECT count(*) n FROM actions").get()).toEqual(before);
  expect(builtInToolSpecs.find((spec) => spec.name === "research.read")).toMatchObject({
    effectPolicy: "pure-read",
    replayPolicy: "boundary-owned",
    workPolicy: "none",
  });
  expect(builtInToolSpecs.find((spec) => spec.name === "environment.info")).toMatchObject({
    effectPolicy: "pure-read",
    replayPolicy: "boundary-owned",
    workPolicy: "none",
  });
  expect(
    environmentReportSchema.parse({
      format: "mate.environment.v2",
      workId: "work",
      snapshotAt: 1,
      filesystem: {
        home: "/srv/mate/private/research",
        sharedRoot: "/srv/mate/shared",
        access: "linux_user_permissions",
      },
      execution: { status: "configured", network: "host" },
      research: {
        status: "unavailable",
        mode: "known_public_https_url_only",
        allowedHosts: [],
        search: false,
      },
      attachmentInput: {
        status: "unavailable",
        scope: "visible_external_message_file",
      },
      artifactOutput: {
        adapterStatus: "configured",
        status: "unavailable",
        scope: "supported_external_target_only",
      },
    }),
  ).toMatchObject({
    filesystem: { access: "linux_user_permissions" },
    research: { search: false },
    artifactOutput: { adapterStatus: "configured", status: "unavailable" },
  });
  const built = buildBaseline(configSchema.parse(configFixture).agents[0]!, operationDocumentation),
    baseline = JSON.stringify(built.messages[0]);
  expect(built.configVersion).toMatch(/^[a-f0-9]{64}$/);
  for (const required of [
    "Ordinary file tools and shell commands use your Linux user account and the same host paths",
    "An absolute path names that path; a relative path starts in your home directory",
    "environment.info can show your home and shared-work paths",
    "It is not search, browsing or URL discovery",
    "use an actually reported networked exec tool if suitable, ask a human or peer for a URL, inspect existing files/history",
    "An attachment caption or metadata is not its content",
    "if the write outcome is unknown, the file may have changed",
    "distinguishes whether an artifact adapter exists for you from whether the current work target supports it",
    "artifact.publish/revise separately preflight the actual explicit target",
    "Publication freezes file bytes into a durable draft",
    "use artifact.revise to freeze a new version",
    "Held, staged, sent, failed and unknown are distinct",
  ])
    expect(baseline).toContain(required);
});

it("rejects a research result when its run stops or aborts while the boundary is awaiting", async () => {
  const stopped = setup();
  let releaseStop!: () => void, enterStop!: () => void;
  const stopEntered = new Promise<void>((resolve) => (enterStop = resolve)),
    stopGate = new Promise<void>((resolve) => (releaseStop = resolve));
  const stoppedRouter = new ToolRouter(stopped.c, stopped.broker, {
    environment: () => ({}),
    research: async () => {
      enterStop();
      await stopGate;
      return { body: "late" };
    },
    publish: async () => ({}),
  });
  const stoppedCall = stoppedRouter.call(
    stopped.run,
    stopped.work,
    "stopped-research",
    "research.read",
    { url: "https://example.com/source" },
    new AbortController().signal,
  );
  await stopEntered;
  stopped.store.finish(stopped.run);
  releaseStop();
  await expect(stoppedCall).rejects.toThrow(/run/i);

  const aborted = setup(),
    controller = new AbortController();
  let releaseAbort!: () => void, enterAbort!: () => void;
  const abortEntered = new Promise<void>((resolve) => (enterAbort = resolve)),
    abortGate = new Promise<void>((resolve) => (releaseAbort = resolve));
  const abortedRouter = new ToolRouter(aborted.c, aborted.broker, {
    environment: () => ({}),
    research: async () => {
      enterAbort();
      await abortGate;
      return { body: "late" };
    },
    publish: async () => ({}),
  });
  const abortedCall = abortedRouter.call(
    aborted.run,
    aborted.work,
    "aborted-research",
    "research.read",
    { url: "https://example.com/source" },
    controller.signal,
  );
  await abortEntered;
  controller.abort();
  releaseAbort();
  await expect(abortedCall).rejects.toThrow();
});
