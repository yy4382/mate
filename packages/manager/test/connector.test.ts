import { CHAT_READ_UNREAD, createAgentStore, openAgentRuntime } from "@mate/runtime";
import { FaultyDatabase } from "@mate/testkit";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { connectInbox, type NoticeTarget } from "../src/index.ts";
import {
  environment,
  FakeWorkspace,
  notices,
  settings,
  text,
  type Environment,
} from "./support.ts";

type Submitted = { content: string; requestId: string; whenBusy?: string; replaces?: string };

/** Stands in for the runtime: keeps the cursor in memory and records every submission. */
class RecordingRuntime implements NoticeTarget {
  readonly submitted: Submitted[] = [];
  position = 0;
  /** While set, `submit` waits for it: a test holds a pass in the middle with it. */
  gate: Promise<void> | undefined;
  failNextCursor = false;

  async cursor(): Promise<number> {
    if (this.failNextCursor) {
      this.failNextCursor = false;
      throw new Error("storage unavailable");
    }
    return this.position;
  }

  async advanceCursor(_name: string, value: number): Promise<void> {
    this.position = Math.max(this.position, value);
  }

  async submit(
    content: string,
    options: { requestId: string; whenBusy?: "steer" | "followUp"; replaces?: string },
  ) {
    await this.gate;
    this.submitted.push({ content, ...options });
    return { settled: async () => "done" as const };
  }
}

/** An Agent account in #general, as the manager would have made it. */
function agentAccount(env: Environment) {
  const account = env.chat.ensureAccount({
    externalId: "agent",
    displayName: "Richard",
    handle: "richard",
    kind: "agent",
  });
  env.chat.invite(env.owner, {
    requestId: "invite",
    conversationId: env.general,
    invitee: account,
  });
  return account;
}

async function connect(env: Environment, account: number, runtime: NoticeTarget) {
  const errors: unknown[] = [];
  const connector = await connectInbox({
    chat: env.chat,
    account,
    runtime,
    clock: env.clock,
    report: (error) => errors.push(error),
  });
  onTestFinished(() => connector.stop());
  return { connector, errors };
}

/** A real runtime on its own store, outside any manager, with a store the test can freeze. */
async function realRuntime(env: Environment) {
  const file = join(env.data, "agent.sqlite");
  await createAgentStore(file, { nodeId: "node-a", settings });
  const workspace = new FakeWorkspace();
  return {
    workspace,
    async open() {
      let database: FaultyDatabase | undefined;
      const runtime = await openAgentRuntime({
        file,
        credentials: () => ({ apiKey: "test-key", baseUrl: env.provider.baseUrl }),
        workspace,
        clock: env.clock,
        wrapDatabase: (inner) => (database = new FaultyDatabase(inner)),
      });
      onTestFinished(() => (database?.frozen ? undefined : runtime.close()));
      return {
        runtime,
        freeze: () => database?.freeze(),
      };
    },
  };
}

const recall = { name: "read", arguments: { path: "MEMORY.md" } };

describe("connector", () => {
  it("turns a new inbox event into one notice with requestId notice:<event ID>, steered in", async () => {
    const env = await environment();
    const account = agentAccount(env);
    const runtime = new RecordingRuntime();
    const { connector } = await connect(env, account, runtime);

    env.post("Hello.");
    await connector.idle();

    const [event] = env.chat.inboxEvents(account);
    expect(
      runtime.submitted.map(({ requestId, whenBusy, replaces }) => ({
        requestId,
        whenBusy,
        replaces,
      })),
    ).toEqual([{ requestId: `notice:${event?.eventId}`, whenBusy: "steer", replaces: "notice:" }]);
    expect(runtime.position, "the position moves to the event").toBe(event?.eventId);
  });

  it("writes the time, the least unread count, mentions, and each timeline with its count, sender, and reference", async () => {
    const env = await environment();
    const account = agentAccount(env);
    const runtime = new RecordingRuntime();
    const { connector } = await connect(env, account, runtime);
    const root = env.post("Release plan?", { mentions: [account] });
    if (root.status !== "sent") throw new Error("setup post was held");
    env.post("Draft is up.", { timeline: { thread: root.messageId } });
    env.post("Reviewing now.", { timeline: { thread: root.messageId }, mentions: [account] });
    const dm = env.chat.openDm(env.owner, { requestId: "dm", other: account }).conversationId;
    env.post("Lunch?", { timeline: { conversation: dm } });
    await connector.idle();

    // One line per timeline, in the order the chat app lists them: the thread opened before the DM.
    expect(runtime.submitted.at(-1)?.content).toBe(
      [
        "截至 2026-01-01 09:30:05 UTC，至少有 4 条未读（其中 2 条 @ 了你），分布在 3 处，之后可能还有更多：",
        `#general {"conversation":${env.general}} 至少 1 条 · 最新发送者 @owner · @了你`,
        `#general/讨论串 {"thread":${root.messageId}} 至少 2 条 · 最新发送者 @owner · @了你`,
        `私信 @owner {"conversation":${dm}} 至少 1 条 · 最新发送者 @owner`,
        `每行花括号里就是 ${CHAT_READ_UNREAD} 要的 timeline。`,
      ].join("\n"),
    );
  });

  it("makes exactly one more pass for signals that arrive during a pass, covering all of them", async () => {
    const env = await environment();
    const account = agentAccount(env);
    const runtime = new RecordingRuntime();
    const { connector } = await connect(env, account, runtime);
    const held = Promise.withResolvers<void>();
    runtime.gate = held.promise;

    env.post("One.");
    await new Promise((resolve) => setTimeout(resolve, 10));
    env.post("Two.");
    env.post("Three.");
    runtime.gate = undefined;
    held.resolve();
    await connector.idle();

    const events = env.chat.inboxEvents(account).map((event) => event.eventId);
    expect(runtime.submitted.map((each) => each.requestId)).toEqual([
      `notice:${events[0]}`,
      `notice:${events[2]}`,
    ]);
    expect(runtime.submitted[1]?.content, "the second pass sees all three").toMatch(
      /至少有 3 条未读/,
    );
  });

  it("submits nothing but still moves past events whose messages were already read", async () => {
    const env = await environment();
    const account = agentAccount(env);
    env.post("Hello.");
    env.chat.readUnread(account, { conversation: env.general }, { requestId: "read" });
    const runtime = new RecordingRuntime();

    await connect(env, account, runtime);

    expect(runtime.submitted).toEqual([]);
    expect(runtime.position).toBe(env.chat.inboxEvents(account)[0]?.eventId);
  });

  it("does not notify for task changes without new messages", async () => {
    const env = await environment();
    const account = agentAccount(env);
    const runtime = new RecordingRuntime();
    const { connector } = await connect(env, account, runtime);
    const sent = env.post("Ship it.");
    if (sent.status !== "sent") throw new Error("setup post was held");
    await connector.idle();
    expect(runtime.submitted, "the message notifies").toHaveLength(1);

    const task = env.chat.createTask(env.owner, {
      requestId: "task",
      messageId: sent.messageId,
      title: "Ship",
    });
    if (task.status !== "applied") throw new Error(`task not created: ${task.status}`);
    env.chat.changeTask(env.owner, {
      requestId: "claim",
      taskId: task.task.taskId,
      change: { kind: "claim" },
    });
    await connector.idle();
    await connector.stop();
    // A fresh start reads from the stored position too.
    await connect(env, account, runtime);

    expect(runtime.submitted, "no notice for the task entries").toHaveLength(1);
  });

  it("reports a failed pass, keeps its position, and catches up on the next signal", async () => {
    const env = await environment();
    const account = agentAccount(env);
    const runtime = new RecordingRuntime();
    const { connector, errors } = await connect(env, account, runtime);
    runtime.failNextCursor = true;

    env.post("One.");
    await connector.idle();
    expect(errors, "the failure is reported").toHaveLength(1);
    expect(runtime.submitted).toEqual([]);

    env.post("Two.");
    await connector.idle();
    expect(runtime.submitted.map((each) => each.content)).toEqual([
      expect.stringMatching(/至少有 2 条未读/),
    ]);
  });

  it("stops notifying once stopped", async () => {
    const env = await environment();
    const account = agentAccount(env);
    const runtime = new RecordingRuntime();
    const { connector } = await connect(env, account, runtime);

    await connector.stop();
    env.post("Anyone?");
    await connector.idle();

    expect(runtime.submitted).toEqual([]);
  });
});

describe("connector with a real runtime", () => {
  it("replaces a notice the model has not been handed yet, so the model sees only the newest", async () => {
    const env = await environment();
    const account = agentAccount(env);
    const agent = await realRuntime(env);
    const { runtime } = await agent.open();
    env.provider
      .step("busy", (request) => void request.call([recall]))
      .step("after the round", (request) => {
        const seen = notices(request.userTexts());
        expect(seen, "one notice").toHaveLength(1);
        expect(seen[0], "the newest").toMatch(/至少有 2 条未读/);
        request.text("noted");
      });
    await runtime.submit("recall", { requestId: "m1" });
    const call = await agent.workspace.nextCall();
    const { connector } = await connect(env, account, runtime);

    env.post("One.");
    await connector.idle();
    env.post("Two.");
    await connector.idle();
    call.resolve(text("notes"));
    await runtime.idle();

    env.provider.assertComplete();
  });

  it("submits the new notice anyway when the old one was handed to the model meanwhile, so the model sees both", async () => {
    const env = await environment();
    const account = agentAccount(env);
    const agent = await realRuntime(env);
    const { runtime } = await agent.open();
    env.provider
      .step("busy", (request) => void request.call([recall]))
      .step("sees the first", (request) => {
        expect(notices(request.userTexts())).toHaveLength(1);
        request.call([recall]);
      })
      .step("sees both", (request) => {
        const seen = notices(request.userTexts());
        expect(seen, "both notices").toHaveLength(2);
        expect(seen[1]).toMatch(/至少有 2 条未读/);
        request.text("noted");
      });
    await runtime.submit("recall", { requestId: "m1" });
    const first = await agent.workspace.nextCall();
    const { connector } = await connect(env, account, runtime);
    env.post("One.");
    await connector.idle();
    first.resolve(text("notes"));
    const second = await agent.workspace.nextCall();

    env.post("Two.");
    await connector.idle();
    second.resolve(text("notes"));
    await runtime.idle();

    env.provider.assertComplete();
  });

  it("submits the same notice again after a crash before its position was stored, and the model sees it once", async () => {
    const env = await environment();
    const account = agentAccount(env);
    const agent = await realRuntime(env);
    const first = await agent.open();
    env.provider
      .step("notice", (request) => {
        expect(notices(request.userTexts()), "the model was handed the notice").toHaveLength(1);
        request.call([recall]);
      })
      .step("after restart", (request) => {
        expect(notices(request.userTexts()), "the notice, once").toHaveLength(1);
        request.text("noted");
      });
    // The Agent is idle, so the notice goes straight to the model. The process dies once the model is working on it,
    // before the position is stored.
    const dies = Promise.withResolvers<void>();
    const dying: NoticeTarget = {
      cursor: (name) => first.runtime.cursor(name),
      submit: (content, options) => first.runtime.submit(content, options),
      advanceCursor: async () => {
        await agent.workspace.nextCall();
        first.freeze();
        dies.resolve();
        return new Promise<void>(() => {});
      },
    };
    const dead = await connectInbox({
      chat: env.chat,
      account,
      runtime: dying,
      clock: env.clock,
      report: () => undefined,
    });
    env.post("One.");
    await dies.promise;
    void dead.stop();

    const second = await agent.open();
    const rerun = await agent.workspace.nextCall();
    await connect(env, account, second.runtime);
    expect(await second.runtime.cursor("chat-inbox"), "the position is stored this time").toBe(
      env.chat.inboxEvents(account)[0]?.eventId,
    );
    rerun.resolve(text("notes"));
    await second.runtime.idle();

    env.provider.assertComplete();
  });
});
