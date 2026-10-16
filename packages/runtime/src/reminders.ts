import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
  type Conversation,
  type Harness,
} from "@earendil-works/pi-durable";
import type { Clock } from "@mate/clock";

type Reminder = { id: string; at: number; note: string };

/** Pending reminders of the primary conversation. A fired reminder is removed after its input is admitted. */
const RemindersDoc = defineDoc<{ pending: Reminder[] }>({
  kind: "mate.reminders",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ pending: [] }),
});

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

/**
 * The `reminder` tool, and the scheduler that turns a due reminder into an input. A reminder's ID derives from the
 * tool call that set it, and its input's request ID from the reminder, so every step is safe to repeat after a crash:
 * re-setting finds the reminder already there, and re-firing is deduplicated by Durable.
 */
export function reminders(clock: Clock, closing: AbortSignal) {
  let wake = new AbortController();
  const reschedule = () => wake.abort();

  const tool = defineTool({
    name: "reminder",
    description:
      "Set, list, or cancel reminders to yourself. A due reminder arrives as a new input, even if you are idle. " +
      "Actions: set (note, and either at as an ISO 8601 time or inMinutes), list, cancel (id).",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("set"), Type.Literal("list"), Type.Literal("cancel")]),
      note: Type.Optional(Type.String()),
      at: Type.Optional(Type.String()),
      inMinutes: Type.Optional(Type.Number({ minimum: 0 })),
      id: Type.Optional(Type.String()),
    }),
    replay: "safe",
    async execute(args, api, context) {
      if (args.action === "list") {
        const pending =
          (await api.snapshot(RemindersDoc, api.conversationId, context))?.pending ?? [];
        return reply(
          pending.length === 0
            ? "No reminders."
            : pending
                .map((item) => `${item.id} at ${new Date(item.at).toISOString()}: ${item.note}`)
                .join("\n"),
        );
      }
      if (args.action === "cancel") {
        if (args.id === undefined) return reply("cancel needs an id.");
        const { id } = args;
        const removed = await api.commit(async (tx) => {
          const state = await tx.doc(RemindersDoc, api.conversationId);
          const before = state.pending.length;
          state.pending = state.pending.filter((item) => item.id !== id);
          return state.pending.length < before;
        }, context);
        reschedule();
        return reply(removed ? `Cancelled ${id}.` : `No pending reminder ${id}.`);
      }
      if (args.note === undefined) return reply("set needs a note.");
      const at = dueTime(args.at, args.inMinutes, clock.now());
      if (at === undefined) return reply("set needs at (an ISO 8601 time) or inMinutes.");
      const reminder = { id: `r${api.taskId}`, at, note: args.note };
      await api.commit(async (tx) => {
        const state = await tx.doc(RemindersDoc, api.conversationId);
        if (!state.pending.some((item) => item.id === reminder.id)) state.pending.push(reminder);
      }, context);
      reschedule();
      return reply(`Set ${reminder.id} for ${new Date(at).toISOString()}.`);
    },
  });

  /** Fire due reminders until the runtime closes, sleeping until the next one is due. */
  async function run(harness: Harness, root: Conversation): Promise<void> {
    while (!closing.aborted) {
      wake = new AbortController();
      try {
        const pending =
          (await harness.snapshot(RemindersDoc, root.id, BACKGROUND_CONTEXT))?.pending ?? [];
        for (const due of pending.filter((item) => item.at <= clock.now() && !closing.aborted)) {
          await root.submit(
            {
              type: "input",
              content: `Reminder you set for ${new Date(due.at).toISOString()}: ${due.note}`,
              requestId: `reminder:${due.id}`,
              whenBusy: "steer",
            },
            BACKGROUND_CONTEXT,
          );
          await root.commit(async (tx) => {
            const state = await tx.doc(RemindersDoc, root.id);
            state.pending = state.pending.filter((item) => item.id !== due.id);
          }, BACKGROUND_CONTEXT);
        }
        const next = pending.filter((item) => item.at > clock.now()).map((item) => item.at);
        const signal = AbortSignal.any([closing, wake.signal]);
        await (next.length === 0
          ? new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            )
          : clock.sleep(Math.min(...next) - clock.now(), signal));
      } catch (error) {
        // The runtime closed or its storage failed while this pass was working. Either way, this loop is done.
        if (closing.aborted) return;
        throw error;
      }
    }
  }

  return { extension: defineExtension({ name: "reminders", tools: [tool] }), run };
}

function dueTime(
  at: string | undefined,
  inMinutes: number | undefined,
  now: number,
): number | undefined {
  if (inMinutes !== undefined) return now + inMinutes * 60_000;
  if (at === undefined) return undefined;
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? undefined : parsed;
}
