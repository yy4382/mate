import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import type { ConversationRole } from "@mate/node-protocol";
import {
  AssistantEntry,
  LiveDoc,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  section,
  type ConversationId,
  type EntryId,
  type DocumentReader,
  type Extension,
  type Tx,
} from "@earendil-works/pi-durable";

type Assistant = {
  conversationId: ConversationId;
  /** Answers already reported, so several messages answered at once are reported once. */
  reported: EntryId[];
};

/** The primary conversation's assistants, by name. */
export const AssistantsDoc = defineDoc<{ assistants: Record<string, Assistant> }>({
  kind: "mate.assistants",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ assistants: {} }),
});

/**
 * In an assistant's own conversation: its name, so its prompt can say who it is, and the primary conversation its
 * answers are reported to. `null` in the primary conversation.
 */
const AssistantIdentityDoc = defineDoc<{
  assistant: { name: string; primary: ConversationId } | null;
}>({
  kind: "mate.assistant-identity",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ assistant: null }),
});

export async function conversationRole(
  read: Pick<DocumentReader, "snapshot">,
  conversationId: ConversationId,
  context: Context,
): Promise<ConversationRole> {
  const identity = await read.snapshot(AssistantIdentityDoc, conversationId, context);
  return identity?.assistant == null ? "main" : "assistant";
}

/**
 * An assistant's conversation must outlive the primary conversation's runs, so it is owned by an anchor: a background
 * task that finishes at once. Background tasks are a boundary for the primary conversation's aborts and idle waits.
 */
const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "mate.assistant-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_anchor, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      ),
  },
  abort: (_anchor, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

type Delivery = {
  /** The conversation the input is for: the primary conversation or one of its assistants. */
  conversationId: ConversationId;
  content: string;
  whenBusy: "steer" | "followUp";
  /** Defaults to `assistant:<task ID>`. */
  requestId?: string;
};
/** A delivery as its task stores it: with the target assistant's name, or `null` for the primary conversation. */
type DelivererInput = Delivery & { assistant: string | null };
type DelivererState = { phase: "deliver" } | { phase: "report"; report?: string };

/**
 * Delivers one input to a conversation of this Agent. When that conversation is an assistant, it waits for the
 * answer and reports it to the primary conversation as a follow-up input. It runs in the primary conversation. Each
 * step is checkpointed and each submission carries a request ID, so after a restart the conversation gets the input
 * once and the primary conversation gets the report once.
 */
const Deliverer = defineTask<DelivererInput, DelivererState, null>({
  name: "mate.input-delivery",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (delivery, runtime, context) => {
      const { conversationId, content, whenBusy, requestId, assistant: name } = delivery.input;
      const target = await runtime.conversation(conversationId, context);
      if (target === undefined) throw new Error(`conversation ${conversationId} is missing`);
      const submission = await target.submit(
        {
          type: "input",
          content,
          whenBusy,
          requestId: requestId ?? `assistant:${delivery.id}`,
        },
        context,
      );
      if (name === null)
        return runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
          context,
        );
      const settled = await submission.wait(context);
      await runtime.commit(async (tx) => {
        type Running = { readonly status: "running"; readonly checkpoint: DelivererState };
        const idle = (): Running => ({ status: "running", checkpoint: { phase: "report" } });
        const withReport = (report: string): Running => ({
          status: "running",
          checkpoint: { phase: "report", report },
        });
        if (settled.status === "unanswered")
          return settled.reason === "aborted"
            ? idle()
            : withReport(`[assistant ${name} failed: ${settled.reason}]`);
        if (settled.type !== "input") return idle();
        const state = await tx.doc(AssistantsDoc, runtime.conversationId);
        const record = state.assistants[name];
        if (record === undefined || record.reported.includes(settled.answer)) return idle();
        record.reported.push(settled.answer);
        const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];
        return withReport(`[assistant ${name} answered] ${textOf(answer)}`);
      }, context);
    },
    report: async (delivery, runtime, context) => {
      const { report } = delivery.state.checkpoint;
      if (report !== undefined) {
        const primary = await runtime.conversation(runtime.conversationId, context);
        if (primary === undefined) throw new Error("primary conversation is missing");
        await primary.submit(
          {
            type: "input",
            content: report,
            whenBusy: "followUp",
            requestId: `assistant-report:${delivery.id}`,
          },
          context,
        );
      }
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
        context,
      );
    },
  },
  abort: (_delivery, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/**
 * Deliver `delivery` to its conversation, in the commit of `tx`. This is the only way an input enters an assistant's
 * conversation, so every answer an assistant gives is reported to the primary conversation, whatever the input.
 */
export async function deliverInput(tx: Tx, delivery: Delivery): Promise<void> {
  const { assistant } = await tx.doc(AssistantIdentityDoc, delivery.conversationId);
  await tx.createTask(
    Deliverer,
    { ...delivery, assistant: assistant?.name ?? null },
    {
      ownership: { kind: "conversation" },
      conversationId: assistant?.primary ?? delivery.conversationId,
      background: true,
    },
  );
}

function textOf(message: unknown): string {
  if (
    typeof message !== "object" ||
    message === null ||
    !("content" in message) ||
    !Array.isArray(message.content)
  )
    return "";
  return message.content
    .flatMap((part: unknown) =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("");
}

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

/**
 * Work assistants: named conversations of this Agent that work in the background and report their answers back.
 * `primaryOnly` lists the extensions an assistant must not have, this one included.
 */
export function assistants(primaryOnly: () => readonly Extension[]) {
  const tool = defineTool({
    name: "assistant",
    description:
      "Delegate work to named assistants that work in the background with their own context, your workspace and your " +
      "model. Actions: spawn (name, message), send (name, message; followUp: true waits for its current answer " +
      "instead of steering it), stop (name: aborts its current work; it stays usable), status (name, or all). " +
      "Each answer is reported back to you as a new input when it arrives.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("spawn"),
        Type.Literal("send"),
        Type.Literal("stop"),
        Type.Literal("status"),
      ]),
      name: Type.Optional(Type.String({ minLength: 1 })),
      message: Type.Optional(Type.String()),
      followUp: Type.Optional(Type.Boolean()),
    }),
    // A repeated `stop` could stop newer work, so an interrupted call is reported, not rerun.
    replay: "unsafe",
    async execute(args, api, context) {
      const { action, name, message, followUp } = args;
      const state = (await api.snapshot(AssistantsDoc, api.conversationId, context)) ?? {
        assistants: {},
      };
      if (action === "status") {
        const names = name === undefined ? Object.keys(state.assistants) : [name];
        const lines: string[] = [];
        for (const each of names) {
          const found = state.assistants[each];
          if (found === undefined) continue;
          const busy =
            (await api.snapshot(LiveDoc, found.conversationId, context))?.run !== undefined;
          lines.push(`${each}: ${busy ? "working" : "idle"}`);
        }
        return reply(lines.length === 0 ? "No assistants." : lines.join("\n"));
      }
      if (name === undefined) return reply(`${action} needs a name.`);
      const existing = state.assistants[name];
      if (action !== "spawn" && existing === undefined) return reply(`No assistant named ${name}.`);
      if (action === "stop") {
        const conversation =
          existing === undefined
            ? undefined
            : await api.conversation(existing.conversationId, context);
        await conversation?.abort(context);
        return reply(`Stopped ${name}.`);
      }
      if (message === undefined) return reply(`${action} needs a message.`);
      const result = await api.commit(async (tx) => {
        const current = await tx.doc(AssistantsDoc, api.conversationId);
        const background = { ownership: { kind: "conversation" }, background: true } as const;
        if (action === "spawn") {
          if (current.assistants[name] !== undefined) return `${name} already exists; use send.`;
          const anchor = await tx.createTask(Anchor, null, background);
          const child = await tx.createConversation({
            ownership: { kind: "task", taskId: anchor },
          });
          await configure(tx, child.id, { extensions: { remove: [...primaryOnly()] } });
          (await tx.doc(AssistantIdentityDoc, child.id)).assistant = {
            name,
            primary: api.conversationId,
          };
          current.assistants[name] = { conversationId: child.id, reported: [] };
        }
        const conversationId = current.assistants[name]?.conversationId;
        if (conversationId === undefined) return `No assistant named ${name}.`;
        await deliverInput(tx, {
          conversationId,
          content: message,
          whenBusy: action === "send" && followUp === true ? "followUp" : "steer",
        });
        return action === "spawn" ? `Started ${name}.` : `Sent to ${name}.`;
      }, context);
      return reply(result);
    },
  });

  const identity = section("assistant", async (input, context) => {
    const name = (await input.read.snapshot(AssistantIdentityDoc, input.conversationId, context))
      ?.assistant?.name;
    return name === undefined
      ? undefined
      : `You are the work assistant "${name}" of this Agent. Work on what the Agent asks of you. Your final answer is ` +
          "reported back to the Agent; you have no chat tools and speak to no one else.";
  });

  return {
    primary: defineExtension({ name: "assistants", tools: [tool], tasks: [Anchor, Deliverer] }),
    /** Installed for every conversation: tells an assistant who it is, and says nothing in the primary conversation. */
    identity: defineExtension({ name: "assistant-identity", sections: [identity] }),
  };
}
