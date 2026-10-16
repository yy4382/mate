import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";

/** Where entries live: a conversation's top level, or the replies under one top-level message. */
export type ChatTimeline = { readonly conversation: number } | { readonly thread: number };

export type ChatTaskChange =
  | { readonly kind: "claim" }
  | { readonly kind: "yield" }
  | { readonly kind: "complete" }
  | { readonly kind: "transfer"; readonly to: number };

/**
 * The chat app as one Agent's account sees it: what the chat tools call. Every write and every forward read carries
 * the tool call's `requestId`, and the chat app answers a repeated `requestId` with the first result, so a call rerun
 * after a crash changes nothing twice. Results are handed to the model as JSON, as the chat app returned them; any
 * method may return a promise. A refusal is thrown as an `Error` with a string `reason`; it becomes an error result the
 * model reads, not a failed tool call.
 *
 * `freshness: true` is the runtime's decision, never the model's: an Agent's write is always held when someone else
 * wrote in the timeline after the Agent last read it.
 */
export interface ChatPort {
  readUnread(timeline: ChatTimeline, request: { readonly requestId: string }): unknown;
  readHistory(
    timeline: ChatTimeline,
    query: { readonly before?: number; readonly limit?: number },
  ): unknown;
  search(query: string): unknown;
  send(
    timeline: ChatTimeline,
    request: {
      readonly requestId: string;
      readonly body: string;
      readonly mentions?: number[];
      readonly freshness: true;
    },
  ): unknown;
  join(request: { readonly requestId: string; readonly conversationId: number }): unknown;
  leave(request: { readonly requestId: string; readonly conversationId: number }): unknown;
  openDm(request: { readonly requestId: string; readonly other: number }): unknown;
  listConversations(): unknown;
  createTask(request: {
    readonly requestId: string;
    readonly messageId: number;
    readonly title: string;
    readonly freshness: true;
  }): unknown;
  changeTask(request: {
    readonly requestId: string;
    readonly taskId: number;
    readonly change: ChatTaskChange;
    readonly freshness: true;
  }): unknown;
}

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

const tools: readonly ((port: ChatPort) => ToolRegistration)[] = [
  chatTool({
    name: "chat_read_unread",
    description:
      "Read a timeline forward from your read position and move the position to its end. When the unread entries " +
      "exceed the budget you get the newest that fit, and the result names the skipped range and the mentions in it.",
    parameters: Type.Object({ timeline: Timeline }),
    call: (port, args, requestId) => port.readUnread(args.timeline, { requestId }),
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
    call: (port, { timeline, before, limit }) =>
      port.readHistory(timeline, {
        ...(before === undefined ? {} : { before }),
        ...(limit === undefined ? {} : { limit }),
      }),
  }),
  chatTool({
    name: "chat_search",
    description:
      "Find entries containing a text, in every timeline you can read. Does not move any read position.",
    parameters: Type.Object({ query: Type.String({ minLength: 1 }) }),
    call: (port, args) => port.search(args.query),
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
    call: (port, { timeline, body, mentions }, requestId) =>
      port.send(timeline, {
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
    call: (port, args, requestId) => port.join({ requestId, conversationId: args.conversationId }),
  }),
  chatTool({
    name: "chat_leave",
    description: "Leave a channel.",
    parameters: Type.Object({ conversationId: Id("Channel ID") }),
    call: (port, args, requestId) => port.leave({ requestId, conversationId: args.conversationId }),
  }),
  chatTool({
    name: "chat_open_dm",
    description:
      "Open the direct-message conversation with another account; returns its conversation ID.",
    parameters: Type.Object({ account: Id("The other account's ID") }),
    call: (port, args, requestId) => port.openDm({ requestId, other: args.account }),
  }),
  chatTool({
    name: "chat_list_conversations",
    description: "List the conversations you can see, with their members and whether you are one.",
    parameters: Type.Object({}),
    call: (port) => port.listConversations(),
  }),
  chatTool({
    name: "chat_create_task",
    description: `Create a task on a message. Nobody owns it until someone claims it. ${HELD}`,
    parameters: Type.Object({
      messageId: Id("The message the task belongs to"),
      title: Type.String({ minLength: 1, maxLength: 200 }),
    }),
    call: (port, { messageId, title }, requestId) =>
      port.createTask({ requestId, messageId, title, freshness: true }),
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
    call: (port, { taskId, change }, requestId) =>
      port.changeTask({ requestId, taskId, change, freshness: true }),
  }),
];

type ChatToolSpec<P extends TSchema> = {
  readonly name: string;
  readonly description: string;
  readonly parameters: P;
  readonly call: (port: ChatPort, args: Static<P>, requestId: string) => unknown;
};

/** One chat tool, to be bound to the Agent's port. Its result, or the chat app's refusal, goes to the model as JSON. */
function chatTool<P extends TSchema>(spec: ChatToolSpec<P>): (port: ChatPort) => ToolRegistration {
  return (port) =>
    defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      replay: "safe",
      async execute(args, api): Promise<ToolExecutionResult> {
        try {
          const result = await spec.call(port, args, `tool:${api.taskId}`);
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
 * The chat tools and the prompt section that says how the Agent speaks. Primary conversation only: an assistant has no
 * chat tools. Every tool is a read or is idempotent on its requestId, the Durable tool task's ID, so all of them rerun
 * safely after a crash and get the chat app's stored result.
 */
export function chatExtension(port: ChatPort) {
  return defineExtension({
    name: "chat",
    tools: tools.map((tool) => tool(port)),
    sections: [
      section(
        "chat",
        () =>
          "You talk with people only through the chat tools. Your plain text output goes nowhere: nobody reads it. " +
          "To say anything to anyone, call chat_send. Inputs that report unread chat are only hints and may be out " +
          "of date; read with chat_read_unread when you decide to.",
      ),
    ],
  });
}
