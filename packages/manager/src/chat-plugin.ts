import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { definePlugin, type Plugin } from "@palace/agent-plugin";
import type { AccountChat, UnreadSummary } from "@palace/chat";

const Id = (description: string) => Type.Integer({ minimum: 1, description });

const Timeline = Type.Union(
  [
    Type.Object({ conversation: Id("Conversation ID") }, { additionalProperties: false }),
    Type.Object(
      { thread: Id("ID of the top-level message the thread hangs under") },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      '{"conversation": id} for a conversation\'s top level, or {"thread": messageId} for the replies under a ' +
      "top-level message. Results use the same shape.",
  },
);

const HELD =
  "If someone wrote in the timeline after you last read it, nothing is done: the result has status held, carries " +
  "the entries you missed, and moves your read position past them. Then resend as it was or revised; both are fine.";

/** The tool that reads a timeline forward, which the unread notice points the model to. */
const CHAT_READ_UNREAD = "chat_read_unread";

const tools: readonly ((account: AccountChat) => ToolRegistration)[] = [
  chatTool({
    name: CHAT_READ_UNREAD,
    description:
      "Read a timeline forward from your read position and move the position to its end. When the unread entries " +
      "exceed the budget you get the newest that fit, and the result names the skipped range and the mentions in it.",
    parameters: Type.Object({ timeline: Timeline }),
    call: (account, args, requestId) => account.readUnread(args.timeline, { requestId }),
  }),
  chatTool({
    name: "chat_read_history",
    description:
      "Read a timeline's entries at or before a sequence number, newest first. Does not move your read position.",
    parameters: Type.Object({
      timeline: Timeline,
      before: Type.Optional(Type.Integer({ minimum: 0, description: "Default: the newest entry" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Default 50" })),
    }),
    call: (account, { timeline, before, limit }) =>
      account.readHistory(timeline, {
        ...(before === undefined ? {} : { before }),
        ...(limit === undefined ? {} : { limit }),
      }),
  }),
  chatTool({
    name: "chat_search",
    description:
      "Find entries containing a text, in every timeline you can read. Does not move any read position.",
    parameters: Type.Object({ query: Type.String({ minLength: 1 }) }),
    call: (account, args) => account.search(args.query),
  }),
  chatTool({
    name: "chat_send",
    description: `Post a message to a timeline. This is the only way anyone sees what you say. ${HELD}`,
    parameters: Type.Object({
      timeline: Timeline,
      body: Type.String({ minLength: 1 }),
      mentions: Type.Optional(
        Type.Array(Type.Integer({ minimum: 1 }), { description: "Account IDs to notify" }),
      ),
    }),
    call: (account, { timeline, body, mentions }, requestId) =>
      account.send(timeline, {
        requestId,
        body,
        freshness: true,
        ...(mentions === undefined ? {} : { mentions }),
      }),
  }),
  chatTool({
    name: "chat_join",
    description: "Join a channel, so you can post in it and are notified of its messages.",
    parameters: Type.Object({ conversationId: Id("Channel ID") }),
    call: (account, args, requestId) =>
      account.join({ requestId, conversationId: args.conversationId }),
  }),
  chatTool({
    name: "chat_leave",
    description: "Leave a channel.",
    parameters: Type.Object({ conversationId: Id("Channel ID") }),
    call: (account, args, requestId) =>
      account.leave({ requestId, conversationId: args.conversationId }),
  }),
  chatTool({
    name: "chat_open_dm",
    description:
      "Open the direct-message conversation with another account; returns its conversation ID.",
    parameters: Type.Object({ account: Id("The other account's ID") }),
    call: (account, args, requestId) => account.openDm({ requestId, other: args.account }),
  }),
  chatTool({
    name: "chat_list_conversations",
    description: "List the conversations you can see, with their members and whether you are one.",
    parameters: Type.Object({}),
    call: (account) => account.listConversations(),
  }),
  chatTool({
    name: "chat_create_task",
    description: `Create a task on a message. Nobody owns it until someone claims it. ${HELD}`,
    parameters: Type.Object({
      messageId: Id("The message the task belongs to"),
      title: Type.String({ minLength: 1, maxLength: 200 }),
    }),
    call: (account, { messageId, title }, requestId) =>
      account.createTask({ requestId, messageId, title, freshness: true }),
  }),
  chatTool({
    name: "chat_change_task",
    description:
      "Claim, yield, complete, or transfer a task. Only its owner can transfer it. A refused change says why and " +
      `shows the task as it is. ${HELD}`,
    parameters: Type.Object({
      taskId: Id("Task ID"),
      change: Type.Union([
        Type.Object({ kind: Type.Literal("claim") }, { additionalProperties: false }),
        Type.Object({ kind: Type.Literal("yield") }, { additionalProperties: false }),
        Type.Object({ kind: Type.Literal("complete") }, { additionalProperties: false }),
        Type.Object(
          { kind: Type.Literal("transfer"), to: Id("The new owner's account ID") },
          { additionalProperties: false },
        ),
      ]),
    }),
    call: (account, { taskId, change }, requestId) =>
      account.changeTask({ requestId, taskId, change, freshness: true }),
  }),
];

type ChatToolSpec<P extends TSchema> = {
  readonly name: string;
  readonly description: string;
  readonly parameters: P;
  readonly call: (account: AccountChat, args: Static<P>, requestId: string) => unknown;
};

/** One chat tool, to be bound to the Agent's account. Its result, or the chat app's refusal, goes to the model as JSON. */
function chatTool<P extends TSchema>(
  spec: ChatToolSpec<P>,
): (account: AccountChat) => ToolRegistration {
  return (account) =>
    defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      replay: "safe",
      async execute(args, api): Promise<ToolExecutionResult> {
        try {
          const result = await spec.call(account, args, `tool:${api.taskId}`);
          return { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }] };
        } catch (error) {
          if (!isRefusal(error)) throw error;
          const text = `Refused (${error.reason}): ${error.message}`;
          return { content: [{ type: "text", text }], isError: true };
        }
      },
    });
}

function isRefusal(error: unknown): error is Error & { reason: string } {
  return error instanceof Error && "reason" in error && typeof error.reason === "string";
}

/**
 * The unread notice as the model reads it: how much is unread at least and where, never what. The counts may be stale
 * by the time the model reads them, which the chat section says once. Each line carries the timeline exactly as the
 * chat tools take it. The connector submits it as requestId `notice:<event ID>`; a newer notice withdraws one still
 * queued, so there is at most one undelivered.
 */
export function renderNotice(summary: UnreadSummary, at: number): string {
  const time = new Date(at)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
  const lines = summary.timelines.map((timeline) => {
    const place = timeline.kind === "dm" ? `私信 @${timeline.label}` : `#${timeline.label}`;
    // Typed as the chat tools' argument, so the line stays something the model can pass to the read tool as is.
    const argument: Static<typeof Timeline> = timeline.timeline;
    const where = `${place}${timeline.inThread ? "/讨论串" : ""} ${JSON.stringify(argument)}`;
    const mention = timeline.mentioned ? " · @了你" : "";
    return `${where} 至少 ${timeline.unread} 条 · 最新发送者 @${timeline.latestSender}${mention}`;
  });
  return [
    `截至 ${time}，至少有 ${summary.total} 条未读（其中 ${summary.mentions} 条 @ 了你），` +
      `分布在 ${summary.timelines.length} 处，之后可能还有更多：`,
    ...lines,
    `每行花括号里就是 ${CHAT_READ_UNREAD} 要的 timeline。`,
  ].join("\n");
}

/**
 * The chat tools and the prompt section that says how the Agent speaks. Primary conversation only: an assistant has no
 * chat tools. Every tool is a read or is idempotent on its requestId, the Durable tool task's ID, so all of them rerun
 * safely after a crash and get the chat app's stored result.
 */
export function chatPlugin(account: AccountChat): Plugin {
  return definePlugin({
    name: "chat",
    scope: "primary",
    prompt:
      "You talk with people only through the chat tools. Your plain text output goes nowhere: nobody reads it. " +
      "To say anything to anyone, call chat_send. " +
      "Inputs that report unread chat are only hints and may be out of date; " +
      `read with ${CHAT_READ_UNREAD} when you decide to.`,
    tools: tools.map((tool) => tool(account)),
  });
}
