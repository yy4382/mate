import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Store } from "../../src/storage/store.js";
import { configSchema } from "../../src/config.js";
import { configFixture } from "../helpers/config.js";
import { Messages, Output, anchoredTask } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { CanonicalAttention } from "../../src/conversations/attention.js";
import { CanonicalFreshnessGate } from "../../src/conversations/freshness.js";
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
import { externalThread, fixtureTarget } from "../helpers/canonical-slack.js";
import type { ConversationDirectory } from "../../src/conversations/directory.js";
import { buildBaseline } from "../../src/runtime/prompt.js";
import { environmentReportSchema } from "../../src/capabilities/environment.js";
import {
  ProcessNotRunningError,
  ProcessStopRejectedError,
  ProcessWaitInterruptedError,
} from "../../src/execution/linux-processes.js";

const stores: Store[] = [],
  roots: string[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => {
    if (store.db.open) store.close();
  });
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
/** One application on a real database file, so building it twice restarts the same data. */
function reopen(path: string) {
  const config = configSchema.parse({
      ...configFixture,
      agents: [
        { ...configFixture.agents[0], channels: { CTEST: "participate" } },
        {
          ...configFixture.agents[0],
          id: "peer",
          name: "Peer",
          slackAppId: "ATWO",
          slackUserId: "UTWO",
          slackBotId: "BTWO",
          botTokenEnv: "PEER_BOT_TOKEN",
          appTokenEnv: "PEER_APP_TOKEN",
          channels: { CTEST: "participate" },
        },
      ],
    }),
    store = new Store(path);
  stores.push(store);
  const messages = new Messages(store, config),
    attention = new CanonicalAttention(messages),
    gate = new CanonicalFreshnessGate(messages, attention),
    c = new Collaboration(
      store,
      messages,
      new Output(messages, { post: async () => ({ ts: "200.000001" }) }, Date.now, gate),
      config,
      attention,
    ),
    broker = new Broker(
      store,
      c,
      { execute: async () => ({ code: 0, stdout: "", stderr: "", truncated: false }) },
      {},
    );
  return { store, messages, c, attention, gate, router: new ToolRouter(c, broker) };
}
/** The supervisor journals every tool result; that journal is what records presentation. */
function journal(value: unknown): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "journal",
    toolName: "mate",
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: false,
    timestamp: 0,
  };
}
function setup(directory?: ConversationDirectory) {
  const config = configSchema.parse(configFixture),
    store = new Store(":memory:");
  stores.push(store);
  const messages = new Messages(store, config);
  const attention = new CanonicalAttention(messages),
    gate = new CanonicalFreshnessGate(messages, attention),
    c = new Collaboration(
      store,
      messages,
      new Output(messages, { post: async () => ({ ts: "200.000001" }) }, Date.now, gate),
      config,
      attention,
    ),
    broker = new Broker(
      store,
      c,
      { execute: async () => ({ code: 0, stdout: "", stderr: "", truncated: false }) },
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
    messages,
    work,
    run,
    router: new ToolRouter(c, broker, undefined, directory),
    broker,
  };
}
const expected = `
history.page history.search history.around history.fetch
conversations.refresh conversations.list conversations.members conversations.openDM conversations.invite
attention.peek attention.read attention.resolve attention.defer attention.mute
messages.send messages.watch inbox.list inbox.read
works.list works.select tasks.list tasks.read tasks.events tasks.byMessage tasks.intents tasks.retry tasks.continue tasks.discard tasks.create tasks.claim tasks.unclaim tasks.transfer tasks.wait tasks.update tasks.delegate
reminders.list reminders.read reminders.log reminders.finish reminders.create reminders.edit reminders.cancel
actions.list actions.read sessions.status sessions.checkpoint sessions.reset environment.info usage.read agents drafts.list drafts.read drafts.retry drafts.continue drafts.revise drafts.discard
file.read_bytes file.write_bytes file.read file.write file.list file.stat file.search file.mkdir file.move file.remove file.edit exec processes.list processes.stop system.request system.status attachments.save artifact.publish artifact.revise`
  .trim()
  .split(/\s+/);

it("registers every public operation exactly once with complete policies and stable documentation order", async () => {
  expect(builtInToolSpecs.map((entry) => entry.name)).toEqual(expected);
  expect(new Set(expected).size).toBe(expected.length);
  expect(Object.isFrozen(builtInToolSpecs)).toBe(true);
  expect(operationContractFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const allowed = {
    replayScope: ["work", "session"],
    seat: ["deny", "redacted-read", "clean-workspace", "held-send"],
    effect: ["pure-read", "atomic-recorded", "broker-recorded", "adapter-recorded"],
    replay: ["immutable", "refreshable", "boundary-owned"],
  };
  for (const entry of builtInToolSpecs) {
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.description.length).toBeGreaterThan(10);
    expect(typeof entry.schema.parse).toBe("function");
    expect(allowed.replayScope).toContain(entry.replayScope);
    expect(allowed.seat).toContain(entry.seatPolicy);
    expect(allowed.effect).toContain(entry.effectPolicy);
    expect(allowed.replay).toContain(entry.replayPolicy);
    expect(typeof entry.authorize).toBe("function");
    expect(typeof entry.handler).toBe("function");
  }
  expect(operationDocumentation).toContain(`Tool contract: ${operationContractFingerprint}`);
  expect(operationDocumentation.match(/Available: (.*)\.\n/)?.[1]?.split(", ")).toEqual(expected);
  const changed = fingerprintToolSpecs([
    { ...builtInToolSpecs[0]!, description: builtInToolSpecs[0]!.description + " changed" },
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

it("offers no self-service channel membership or unjoined-channel search", () => {
  const removed = [
    "conversations.capabilities",
    "conversations.discover",
    "conversations.join",
    "conversations.leave",
  ];
  const names = builtInToolSpecs.map((entry) => entry.name);
  for (const name of removed) expect(names).not.toContain(name);
  const baseline = JSON.stringify(
    buildBaseline(configSchema.parse(configFixture).agents[0]!, operationDocumentation).messages[0],
  );
  for (const name of removed) expect(baseline).not.toContain(name);
  expect(baseline).toContain("cannot join or leave a channel");
});

it("describes local coverage, remote acquisition and attention.read as three different reads", () => {
  const described = (name: string) =>
      builtInToolSpecs.find((entry) => entry.name === name)!.description,
    baseline = JSON.stringify(
      buildBaseline(configSchema.parse(configFixture).agents[0]!, operationDocumentation)
        .messages[0],
    );
  // Local coverage: what this Agent already has, live, ordered newest first per conversation.
  for (const name of ["history.page", "history.search", "history.around"] as const) {
    expect(described(name)).toMatch(/locally covered/i);
    expect(described(name)).toMatch(/newest first per conversation|nearest locally covered/i);
    expect(described(name)).toMatch(/live|read-only/i);
  }
  expect(described("history.page")).toMatch(/continuation cursor/i);
  expect(described("history.page")).toMatch(/never records presentation/i);
  expect(described("history.page")).toMatch(/never mints the freshness view token/i);
  expect(described("history.search")).toMatch(/nothing and still continue/i);
  // Remote acquisition: one page through this Agent's own installation, quiet.
  expect(described("history.fetch")).toMatch(/remote history/i);
  expect(described("history.fetch")).toMatch(/own platform installation/i);
  expect(described("history.fetch")).toMatch(/continuation cursor/i);
  expect(described("history.fetch")).toMatch(/wakes nobody and presents nothing/i);
  // attention.read is the frozen snapshot that presents, and the only token source.
  const attention = described("attention.read");
  expect(attention).toMatch(/frozen/i);
  expect(attention).toMatch(/records presentation/i);
  expect(attention).toMatch(/mints the freshness view token/i);
  expect(baseline).toContain("attention.read presents a paginated snapshot");
  expect(baseline).toContain("never create a whole-target viewToken");
  expect(baseline).toContain("only attention.read presents a whole-target snapshot");
});

it("keeps mute, follow and defer as the Agent's own attention choices", async () => {
  const { router, run, work, messages } = setup(),
    signal = new AbortController().signal,
    target = { conversationId: "CTEST" },
    speak = (ts: string, text = "ordinary background activity") =>
      messages.record(
        {
          team: "TTEST",
          channel: "CTEST",
          ts,
          thread: ts,
          revision: ts,
          text,
          user: "UOWNER",
          deleted: false,
        },
        ["research"],
      ),
    inbox = async (callId: string) =>
      (
        (await router.call(run, work, callId, "inbox.list", {}, signal)).value as {
          kind?: string;
        }[]
      )
        .map((delivery) => delivery.kind)
        // The fixture's own work-start delivery carries no message kind.
        .filter((kind) => kind === "notice" || kind === "message");
  // CTEST is a mentions-only channel: ordinary activity stays quiet until followed.
  speak("101.000001");
  expect(await inbox("inbox-quiet")).toEqual([]);
  await router.call(run, work, "follow", "messages.watch", { target, active: true }, signal);
  speak("102.000001");
  expect(await inbox("inbox-followed")).toEqual(["message"]);
  await router.call(run, work, "mute", "attention.mute", { target, active: true }, signal);
  speak("103.000001");
  expect(await inbox("inbox-muted")).toEqual(["message"]);
  speak("104.000001", "<@UONE> a direct request still surfaces");
  expect(await inbox("inbox-mute-direct")).toEqual(["message", "message"]);
  await router.call(run, work, "unmute", "attention.mute", { target, active: false }, signal);
  await router.call(
    run,
    work,
    "defer",
    "attention.defer",
    { target, until: Date.now() + 60000 },
    signal,
  );
  speak("105.000001");
  speak("106.000001", "<@UONE> defer postpones even a direct request");
  expect(await inbox("inbox-deferred")).toEqual(["message", "message"]);
});

it("shows this Agent's own durable reminder delivery after a restart, never a peer's inbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "mate-inbox-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  const signal = new AbortController().signal,
    target = fixtureTarget("CTEST", "100.000001"),
    first = reopen(path);
  for (const actor of ["research", "peer"]) {
    first.store.register(actor, "v1", []);
    first.messages.membership(actor, "CTEST", true);
  }
  const work = first.c.createWork("tools", target);
  first.c.enqueue("research", work, "start", {});
  const run = first.store.beginRun("research")!;
  first.store.input(run, {});
  first.c.reminders.create("research", work, {
    target,
    content: "Check whether the completed change is still healthy",
    nextAt: 1000,
    timezone: "Asia/Shanghai",
    projection: "private",
  });
  first.c.tick(2000);
  const peer = first.c.enqueue("peer", work, "peer-only", { kind: "delegation", target });
  first.store.close();

  const restarted = reopen(path),
    listed = ((await restarted.router.call(run, work, "restarted-list", "inbox.list", {}, signal))
      .value ?? []) as { id: string; status: string; kind?: string }[];
  // The reminder this Agent set is still its own durable inbox input after the restart.
  expect(listed.filter((delivery) => delivery.kind === "reminder")).toEqual([
    { id: expect.any(String), status: "pending", kind: "reminder" },
  ]);
  // A peer's delivery is not this Agent's inbox, and its id is not a read handle for this Agent.
  expect(listed.map((delivery) => delivery.id)).not.toContain(peer);
  await expect(
    restarted.router.call(run, work, "peer-delivery", "inbox.read", { deliveryId: peer }, signal),
  ).rejects.toThrow("Private inbox");
  const reminder = listed.find((delivery) => delivery.kind === "reminder")!;
  expect(
    (
      await restarted.router.call(
        run,
        work,
        "own-delivery",
        "inbox.read",
        { deliveryId: reminder.id },
        signal,
      )
    ).value,
  ).toMatchObject({
    id: reminder.id,
    agent_id: "research",
    status: "pending",
    payload: {
      kind: "reminder",
      content: "Check whether the completed change is still healthy",
    },
  });
});

it("advances scheduling and attention independently, so neither settles the other", async () => {
  const { router, run, work, store, c, messages } = setup(),
    signal = new AbortController().signal,
    target = { conversationId: "CTEST" },
    thread = externalThread(fixtureTarget("CTEST", "100.000001")),
    speak = (ts: string) =>
      messages.record(
        {
          team: "TTEST",
          channel: "CTEST",
          ts,
          thread,
          revision: ts,
          text: "ordinary background activity",
          user: "UOWNER",
          deleted: false,
        },
        ["research"],
      );
  // A task change arrives as durable input while a peer message arrives as unread attention.
  const delegation = c.enqueue("research", work, "task-change", { kind: "delegation", target });
  speak("101.000001");
  expect((await router.call(run, work, "peek", "attention.peek", {}, signal)).value).toMatchObject([
    { unseen: 1 },
  ]);
  // Attention's own choice settles attention and leaves the delivery queue where the scheduler left it.
  await router.call(
    run,
    work,
    "resolve",
    "attention.resolve",
    { target, throughRevision: c.attention.revision(target, "research") },
    signal,
  );
  expect(c.attention.peek("research")).toEqual([]);
  expect(store.delivery(delegation).status).toBe("pending");
  expect(store.delivery(run.deliveryId).status).toBe("injected");
  // The scheduler's own completion settles the delivery it ran and leaves unread attention alone.
  speak("102.000001");
  expect(c.attention.peek("research")).toMatchObject([{ unseen: 1 }]);
  store.finish(run);
  expect(store.delivery(run.deliveryId).status).toBe("handled");
  expect(store.delivery(delegation).status).toBe("pending");
  expect(c.attention.peek("research")).toMatchObject([{ unseen: 1 }]);
});

it("keeps a quiet history read from presenting, processing or waking anybody", async () => {
  const { router, run, work, store, c, messages } = setup(),
    signal = new AbortController().signal,
    target = { conversationId: "CTEST" },
    counted = (sql: string) => (store.db.prepare(sql).get() as { n: number }).n;
  messages.record(
    {
      team: "TTEST",
      channel: "CTEST",
      ts: "101.000001",
      thread: externalThread(fixtureTarget("CTEST", "100.000001")),
      revision: "101.000001",
      text: "ordinary background activity",
      user: "UOWNER",
      deleted: false,
    },
    ["research"],
  );
  const deliveries = counted("SELECT count(*) n FROM deliveries"),
    due = counted(
      "SELECT count(*) n FROM deliveries WHERE json_extract(payload,'$.kind')='attention_due'",
    );
  const page = (await router.call(run, work, "page", "history.page", { target, limit: 5 }, signal))
    .value as { messages: { text: string }[] };
  expect(page.messages.map((message) => message.text)).toEqual(["ordinary background activity"]);
  expect(page).not.toHaveProperty("viewToken");
  // The read observed the discussion without presenting, processing or waking the Agent.
  expect(counted("SELECT count(*) n FROM attention_presented")).toBe(0);
  expect(counted("SELECT count(*) n FROM attention_seen")).toBe(0);
  expect(c.attention.peek("research")).toMatchObject([{ unseen: 1 }]);
  expect(counted("SELECT count(*) n FROM deliveries")).toBe(deliveries);
  expect(
    counted(
      "SELECT count(*) n FROM deliveries WHERE json_extract(payload,'$.kind')='attention_due'",
    ),
  ).toBe(due);
});

it("keeps silence and every pre-send choice reachable on a held draft", async () => {
  const { router, run, work, store, c } = setup(),
    signal = new AbortController().signal,
    target = { conversationId: "CTEST" },
    propose = async (callId: string, text: string) =>
      (await router.call(run, work, callId, "messages.send", { target, text }, signal)).value as {
        draftId: string;
        revision: number;
        status: string;
        holdId: string | null;
        choices: string[];
        text: string;
      },
    sent = () =>
      (store.db.prepare("SELECT count(*) n FROM outbox WHERE state='sent'").get() as { n: number })
        .n;
  // Silence is reachable: proposing output only creates a draft, and nothing is delivered for it.
  const first = await propose("propose", "first proposal");
  expect(first.status).toBe("held");
  expect(first.choices).toEqual(["retry_with_view", "revise", "discard", "continue_once"]);
  expect(sent()).toBe(0);
  // Revise, then discard the revised draft.
  const revised = (
    await router.call(
      run,
      work,
      "revise",
      "drafts.revise",
      { draftId: first.draftId, revision: first.revision, text: "revised proposal" },
      signal,
    )
  ).value as { revision: number; status: string; text: string };
  expect(revised).toMatchObject({ revision: 2, status: "held", text: "revised proposal" });
  const discarded = (
    await router.call(
      run,
      work,
      "discard",
      "drafts.discard",
      { draftId: first.draftId, revision: revised.revision },
      signal,
    )
  ).value as { status: string };
  expect(discarded.status).toBe("failed");
  // Retry only after a current view was actually presented.
  const second = await propose("propose-again", "second proposal");
  const view = (await router.call(run, work, "view", "attention.read", { target }, signal))
    .value as { viewToken: string };
  expect(
    (
      await router.call(
        run,
        work,
        "retry-without-view",
        "drafts.retry",
        { draftId: second.draftId, revision: second.revision, viewToken: "foreign" },
        signal,
      )
    ).value,
  ).toMatchObject({ status: "held" });
  c.attention.presented(run, journal(view));
  const retried = (
    await router.call(
      run,
      work,
      "retry-with-view",
      "drafts.retry",
      { draftId: second.draftId, revision: second.revision, viewToken: view.viewToken },
      signal,
    )
  ).value as { status: string };
  expect(retried.status).toBe("pending");
  // Informed continue needs the hold receipt the conflict reported.
  const third = await propose("propose-once-more", "third proposal");
  await expect(
    router.call(
      run,
      work,
      "continue-without-receipt",
      "drafts.continue",
      {
        draftId: third.draftId,
        revision: third.revision,
        holdId: "not-the-reported-receipt",
        acknowledge: "send_despite_unread_or_changes",
      },
      signal,
    ),
  ).rejects.toThrow("receipt");
  expect(
    (
      await router.call(
        run,
        work,
        "continue-with-receipt",
        "drafts.continue",
        {
          draftId: third.draftId,
          revision: third.revision,
          holdId: third.holdId,
          acknowledge: "send_despite_unread_or_changes",
        },
        signal,
      )
    ).value,
  ).toMatchObject({ status: "pending" });
  // The Agent chose every one of those; the router itself never delivered anything.
  expect(sent()).toBe(0);
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
    build([{ domain: "x", specs: [{ ...base, replayScope: "ambient" } as any] }]),
  ).toThrow(/unknown/);
  expect(() =>
    build([{ domain: "x", specs: [{ ...base, effectPolicy: "atomic-recorded" } as any] }]),
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
  const args = { target: fixtureTarget("CTEST", "100.000001"), title: "must not appear" },
    actionId = `${run.sessionId}:busy`;
  store.prepareAction(run, actionId, { workId: work, operation: "tasks.create", args });
  store.startAction(run, actionId);
  await expect(router.call(run, work, "busy", "tasks.create", args, signal)).rejects.toThrow(
    "Uncertain tool action",
  );
  expect((store.db.prepare("SELECT count(*) n FROM tasks").get() as { n: number }).n).toBe(0);
});

it("replays pre-module receipts with the original selected-work request identity", async () => {
  const { router, run, work, store, c } = setup(),
    other = c.createWork("other", { conversationId: "CTEST" }),
    taskId = anchoredTask(c, "research", other, { conversationId: "CTEST" }, "cross-work"),
    args = { taskId, expectedVersion: 0, status: "done" as const, result: "legacy" },
    actionId = `${run.sessionId}:legacy-cross-work`;
  store.prepareAction(run, actionId, { workId: work, operation: "tasks.update", args });
  store.startAction(run, actionId);
  store.settleAction(run, actionId, "succeeded", { value: { legacyReceipt: true }, wait: false });
  await expect(
    router.call(run, work, "legacy-cross-work", "tasks.update", args, new AbortController().signal),
  ).resolves.toEqual({ value: { legacyReceipt: true }, wait: false });
  expect(c.task(taskId).status).toBe("todo");
});

it("authorizes task and reminder effects against their bound work while retaining legacy receipt identity", async () => {
  const { router, run, work, c, store } = setup(),
    other = c.createWork("other", { conversationId: "CTEST" }),
    taskId = anchoredTask(c, "research", other, { conversationId: "CTEST" }, "cross-work");
  c.claim("research", taskId);
  const signal = new AbortController().signal;
  const held = (
    await router.call(
      run,
      work,
      "cross-task",
      "tasks.update",
      { taskId, expectedVersion: c.task(taskId).version, status: "done", result: "evidence" },
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

it("keeps an author's reminder reschedulable and cancellable after the task it mentions ended", async () => {
  const { router, run, work, c } = setup(),
    signal = new AbortController().signal,
    target = { conversationId: "CTEST" };
  // The reminder names a task in a work item of its own, so the task's lifecycle and the work
  // item's lifecycle stay separate facts.
  const attached = c.createWork("attached-source", target),
    taskId = anchoredTask(c, "research", attached, target, "attached change");
  c.claim("research", taskId);
  const reminder = (
    await router.call(
      run,
      work,
      "own-reminder",
      "reminders.create",
      {
        target,
        content: "keep the commitment",
        nextAt: Date.now() + 60000,
        timezone: "UTC",
        taskId,
      },
      signal,
    )
  ).value as { id: string; work_id: string; version: number };
  expect(reminder.work_id).toBe(attached);
  const held = (
    await router.call(
      run,
      work,
      "end-mentioned-task",
      "tasks.update",
      { taskId, status: "done", result: "verified", expectedVersion: c.task(taskId).version },
      signal,
    )
  ).value as { intentId: string; holdId: string };
  await router.call(
    run,
    work,
    "apply-mentioned-task-end",
    "tasks.continue",
    {
      intentId: held.intentId,
      holdId: held.holdId,
      acknowledge: "apply_despite_unread_or_changes",
    },
    signal,
  );
  expect(c.task(taskId).status).toBe("done");
  // Ending the task neither cancels the reminder nor blocks its author from changing it.
  expect(c.reminders.read("research", reminder.id).active).toBe(1);
  const rescheduled = (
    await router.call(
      run,
      work,
      "reschedule-own-reminder",
      "reminders.edit",
      {
        reminderId: reminder.id,
        expectedVersion: reminder.version,
        target,
        content: "keep the commitment",
        nextAt: Date.now() + 120000,
        timezone: "UTC",
        taskId,
      },
      signal,
    )
  ).value as { reminder: { version: number; active: number } };
  expect(rescheduled.reminder).toMatchObject({ active: 1 });
  const cancelled = (
    await router.call(
      run,
      work,
      "cancel-own-reminder",
      "reminders.cancel",
      { reminderId: reminder.id, expectedVersion: rescheduled.reminder.version },
      signal,
    )
  ).value as { futureCancelled: boolean };
  expect(cancelled.futureCancelled).toBe(true);
  expect(c.reminders.read("research", reminder.id).active).toBe(0);
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
  c.createTask({
    agentId: "research",
    workId: bound,
    target,
    title: "claim this",
    messageKey: messageId,
    pendingOutboxId: "fixture-claim-this",
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
      return { spaces: [], coverage: [] };
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
    (await router.call(run, work, "list", "tools.list", {}, signal)).value as { name: string }[]
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
  expect(stop).toHaveBeenCalledExactlyOnceWith("research", unit, signal);
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

it("retires the unused inbox acknowledgement instead of recording a second delivery state", async () => {
  const { router, run, work, store } = setup(),
    signal = new AbortController().signal;
  expect(builtInToolSpecs.map((entry) => entry.name)).not.toContain("inbox.ack");
  await expect(
    router.call(run, work, "retired-ack", "inbox.ack", { deliveryId: run.deliveryId }, signal),
  ).rejects.toThrow("Unknown operation");
  expect(
    store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inbox_reads'")
      .get(),
  ).toBeUndefined();
  // Listing and reading observe the durable delivery; the scheduler still owns its status.
  await router.call(run, work, "list-not-handled", "inbox.list", {}, signal);
  await router.call(
    run,
    work,
    "read-not-handled",
    "inbox.read",
    { deliveryId: run.deliveryId },
    signal,
  );
  expect(store.delivery(run.deliveryId).status).toBe("injected");
});

it("keeps private recovery and own inbox reads available after work pauses", async () => {
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
  const read = await base.router.call(
    base.run,
    base.work,
    "paused-read",
    "inbox.read",
    { deliveryId: base.run.deliveryId },
    signal,
  );
  expect(read.value).toMatchObject({ id: base.run.deliveryId });
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
      { draftId: draft.draftId, revision: draft.revision, text: "revised proposal" },
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
  ).toMatchObject({ status: "failed", receipt: { reason: "Agent scope is not running" } });
  expect(stop).toHaveBeenCalledTimes(1);
});

it("keeps a cancelled stop's unknown result recoverable through the run that was fenced", async () => {
  const base = setup(),
    unit = "mate-agent-1001-123e4567-e89b-42d3-a456-426614174000.scope",
    controller = new AbortController();
  let attempts = 0;
  const stop = vi.fn(async (_agentId: string, _unit: string, signal?: AbortSignal) => {
    attempts += 1;
    if (attempts > 1) return { unit, stopped: true };
    return new Promise<never>((_resolve, reject) =>
      signal?.addEventListener(
        "abort",
        () => reject(new ProcessWaitInterruptedError("systemctl stop cancelled")),
        { once: true },
      ),
    );
  });
  const router = new ToolRouter(base.c, base.broker, {
      processes: { list: async () => [{ unit, pids: [4101] }], stop },
      publish: async () => ({}),
    }),
    stopping = router.call(
      base.run,
      base.work,
      "stop-cancelled",
      "processes.stop",
      { unit },
      controller.signal,
    );
  await vi.waitFor(() => expect(attempts).toBe(1));
  // The production cancel: pausing the Agent fences the run and conservatively marks its executing
  // action unknown before the aborted wait settles.
  base.store.pause("research");
  controller.abort();
  await expect(stopping).rejects.toBeInstanceOf(ProcessWaitInterruptedError);
  const action = base.store.action(`${base.run.sessionId}:stop-cancelled`);
  expect(action?.state).toBe("unknown");
  expect(JSON.parse(action!.receipt!)).toMatchObject({
    reason: "process_stop_outcome_unknown",
    unit,
    cause: "cancelled_or_timed_out",
  });
  // Explicitly resumed work can inspect the scopes and try the stop again.
  base.store.resume("research");
  const resumed = base.store.beginRun("research")!;
  base.store.input(resumed, {});
  const list = await router.call(
    resumed,
    base.work,
    "list-after-cancel",
    "processes.list",
    {},
    new AbortController().signal,
  );
  expect(list.value).toEqual([{ unit, pids: [4101] }]);
  const retried = await router.call(
    resumed,
    base.work,
    "stop-again",
    "processes.stop",
    { unit },
    new AbortController().signal,
  );
  expect(retried.value).toEqual({ unit, stopped: true });
  expect(attempts).toBe(2);
});

it("records a stop refused before the boundary as failed even when its run was fenced", async () => {
  const base = setup(),
    unit = "mate-agent-1001-123e4567-e89b-42d3-a456-426614174000.scope",
    controller = new AbortController();
  const stop = vi.fn(async (_agentId: string, _unit: string, signal?: AbortSignal) => {
    return new Promise<never>((_resolve, reject) =>
      signal?.addEventListener(
        "abort",
        () => reject(new ProcessStopRejectedError("Stop cancelled before systemctl stop")),
        { once: true },
      ),
    );
  });
  const router = new ToolRouter(base.c, base.broker, {
      processes: { list: async () => [], stop },
      publish: async () => ({}),
    }),
    stopping = router.call(
      base.run,
      base.work,
      "stop-refused-fenced",
      "processes.stop",
      { unit },
      controller.signal,
    );
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  base.store.pause("research");
  controller.abort();
  await expect(stopping).rejects.toBeInstanceOf(ProcessStopRejectedError);
  const action = base.store.action(`${base.run.sessionId}:stop-refused-fenced`);
  expect(action?.state).toBe("failed");
  expect(JSON.parse(action!.receipt!)).toEqual({
    reason: "Stop cancelled before systemctl stop",
    unit,
  });
});

it("keeps environment.info a receipt-free read and states the ordinary Linux network capability", async () => {
  const base = setup(),
    router = new ToolRouter(base.c, base.broker, {
      environment: () => ({}),
      publish: async () => ({}),
    }),
    signal = new AbortController().signal;
  const before = base.store.db.prepare("SELECT count(*) n FROM actions").get();
  const result = await router.call(
    base.run,
    base.work,
    "environment",
    "environment.info",
    {},
    signal,
  );
  expect(result.value).toEqual({});
  expect(base.store.db.prepare("SELECT count(*) n FROM actions").get()).toEqual(before);
  expect(builtInToolSpecs.find((spec) => spec.name === "environment.info")).toMatchObject({
    effectPolicy: "pure-read",
    replayPolicy: "boundary-owned",
    replayScope: "work",
  });
  expect(
    environmentReportSchema.parse({
      format: "mate.environment.v3",
      workId: "work",
      snapshotAt: 1,
      filesystem: {
        home: "/srv/mate/private/research",
        sharedRoot: "/srv/mate/shared",
        access: "linux_user_permissions",
      },
      execution: { status: "configured", network: "host" },
      attachmentInput: { status: "unavailable", scope: "visible_external_message_file" },
      artifactOutput: {
        adapterStatus: "configured",
        status: "unavailable",
        scope: "supported_external_target_only",
      },
    }),
  ).toMatchObject({
    filesystem: { access: "linux_user_permissions" },
    execution: { network: "host" },
    artifactOutput: { adapterStatus: "configured", status: "unavailable" },
  });
  const built = buildBaseline(configSchema.parse(configFixture).agents[0]!, operationDocumentation),
    baseline = JSON.stringify(built.messages[0]);
  expect(built.configVersion).toMatch(/^[a-f0-9]{64}$/);
  for (const required of [
    "Ordinary file tools and shell commands use your Linux user account and the same host paths",
    "An absolute path names that path; a relative path starts in your home directory",
    "environment.info can show your home and shared-work paths",
    "Ordinary networking goes through your own Linux user rather than a dedicated tool",
    "No dedicated URL-reading or search tool exists, so report what the network actually does as an environment fact",
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

it("rechecks run eligibility and visibility after an awaited operation is overtaken", async () => {
  const stopped = setup();
  let releaseStop!: () => void, enterStop!: () => void;
  const stopEntered = new Promise<void>((resolve) => (enterStop = resolve)),
    stopGate = new Promise<void>((resolve) => (releaseStop = resolve));
  const stoppedDirectory = {
    list: async () => {
      enterStop();
      await stopGate;
      return { spaces: [], coverage: [] };
    },
    spaces: async () => {
      enterStop();
      await stopGate;
      return { spaces: [], coverage: [] };
    },
  } as unknown as ConversationDirectory;
  const stoppedRouter = new ToolRouter(stopped.c, stopped.broker, undefined, stoppedDirectory);
  const stoppedCall = stoppedRouter.call(
    stopped.run,
    stopped.work,
    "stopped-list",
    "conversations.list",
    {},
    new AbortController().signal,
  );
  await stopEntered;
  stopped.store.finish(stopped.run);
  releaseStop();
  await expect(stoppedCall).rejects.toThrow(/run/i);

  const aborted = setup();
  let releaseAbort!: () => void, enterAbort!: () => void;
  const abortEntered = new Promise<void>((resolve) => (enterAbort = resolve)),
    abortGate = new Promise<void>((resolve) => (releaseAbort = resolve));
  const abortedDirectory = {
    spaces: async () => {
      enterAbort();
      await abortGate;
      return { spaces: [], coverage: [] };
    },
  } as unknown as ConversationDirectory;
  const abortedRouter = new ToolRouter(aborted.c, aborted.broker, undefined, abortedDirectory);
  const controller = new AbortController();
  const abortedCall = abortedRouter.call(
    aborted.run,
    aborted.work,
    "aborted-list",
    "conversations.list",
    {},
    controller.signal,
  );
  await abortEntered;
  controller.abort();
  releaseAbort();
  await expect(abortedCall).rejects.toThrow();
});

it("rechecks an operation's own visibility against access withdrawn while it awaited", async () => {
  const base = setup(),
    messageId = "MVISIBLE",
    target = fixtureTarget("CTEST", "100.000001");
  base.c.messages.record(
    {
      id: messageId,
      conversationId: target.conversationId,
      rootId: messageId,
      order: "100000001",
      revision: "100000001",
      text: "an attached brief",
      author: { kind: "human", id: "UOWNER" },
      origin: "participant",
      mentions: [],
      attachments: [],
      deleted: false,
    },
    ["research"],
  );
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    started = new Promise<void>((resolve) => (entered = resolve));
  const router = new ToolRouter(base.c, base.broker, {
    attachment: async () => {
      entered();
      await gate;
      return { saved: true };
    },
    publish: async () => ({}),
  });
  const call = router.call(
    base.run,
    base.work,
    "save-while-awaiting",
    "attachments.save",
    { message: { messageId }, fileId: "FFILE", path: "brief.txt" },
    new AbortController().signal,
  );
  await started;
  base.c.messages.membership("research", "CTEST", false);
  release();
  await expect(call).rejects.toThrow();
});
