import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
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
  type Extension,
  type TaskId,
} from "@earendil-works/pi-durable";

type Assistant = {
  conversationId: ConversationId;
  /** Answers already reported, so several messages answered at once are reported once. */
  reported: EntryId[];
};

/** The primary conversation's assistants, by name. */
const AssistantsDoc = defineDoc<{
  assistants: Record<string, Assistant>;
  reporters: Record<string, TaskId>;
}>({
  kind: "mate.assistants",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ assistants: {}, reporters: {} }),
});

/** In an assistant's own conversation: its name, so its prompt can say who it is. */
const AssistantIdentityDoc = defineDoc<{ name: string }>({
  kind: "mate.assistant-identity",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ name: "" }),
});

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

type ReporterInput = {
  name: string;
  conversationId: ConversationId;
  message: string;
  followUp: boolean;
};
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };

/**
 * Delivers one message to an assistant, waits for its answer, and reports the answer to the primary conversation as a
 * follow-up input. Each step is checkpointed and each submission carries a request ID, so after a restart the
 * assistant gets the message once and the Agent gets the report once.
 */
const Reporter = defineTask<ReporterInput, ReporterState, null>({
  name: "mate.assistant-reporter",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (reporter, runtime, context) => {
      const { name, conversationId, message, followUp } = reporter.input;
      const assistant = await runtime.conversation(conversationId, context);
      if (assistant === undefined)
        throw new Error(`assistant conversation ${conversationId} is missing`);
      const submission = await assistant.submit(
        {
          type: "input",
          content: message,
          whenBusy: followUp ? "followUp" : "steer",
          requestId: `assistant:${reporter.id}`,
        },
        context,
      );
      const settled = await submission.wait(context);
      await runtime.commit(async (tx) => {
        type Running = { readonly status: "running"; readonly checkpoint: ReporterState };
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
    report: async (reporter, runtime, context) => {
      const { report } = reporter.state.checkpoint;
      if (report !== undefined) {
        const primary = await runtime.conversation(runtime.conversationId, context);
        if (primary === undefined) throw new Error("primary conversation is missing");
        await primary.submit(
          {
            type: "input",
            content: report,
            whenBusy: "followUp",
            requestId: `assistant-report:${reporter.id}`,
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
  abort: (_reporter, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

function textOf(message: AssistantMessage | undefined | unknown): string {
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
        reporters: {},
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
          (await tx.doc(AssistantIdentityDoc, child.id)).name = name;
          current.assistants[name] = { conversationId: child.id, reported: [] };
        }
        const conversationId = current.assistants[name]?.conversationId;
        if (conversationId === undefined) return `No assistant named ${name}.`;
        current.reporters[String(api.taskId)] = await tx.createTask(
          Reporter,
          { name, conversationId, message, followUp: action === "send" && followUp === true },
          background,
        );
        return action === "spawn" ? `Started ${name}.` : `Sent to ${name}.`;
      }, context);
      return reply(result);
    },
  });

  const identity = section("assistant", async (input, context) => {
    const name = (await input.read.snapshot(AssistantIdentityDoc, input.conversationId, context))
      ?.name;
    return name === undefined || name === ""
      ? undefined
      : `You are the work assistant "${name}" of this Agent. Work on what the Agent asks of you. Your final answer is ` +
          "reported back to the Agent; you have no chat tools and speak to no one else.";
  });

  return {
    primary: defineExtension({ name: "assistants", tools: [tool], tasks: [Anchor, Reporter] }),
    /** Installed for every conversation: tells an assistant who it is, and says nothing in the primary conversation. */
    identity: defineExtension({ name: "assistant-identity", sections: [identity] }),
  };
}
