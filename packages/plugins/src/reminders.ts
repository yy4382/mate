import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { systemClock, type Clock } from "@palace/clock";
import type { RuntimeBackgroundTask } from "@palace/runtime";

type Reminder = { id: string; at: number; note: string };

const MAX_PENDING_REMINDERS = 100;

/** Pending reminders of the primary conversation. A fired reminder is removed after its input is admitted. */
const RemindersDoc = defineDoc<{ pending: Reminder[] }>({
  kind: "mate.reminders",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ pending: [] }),
});

const reply = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  isError,
});

/**
 * Self-reminders for the primary conversation. Returns the `reminder` tool extension and the background wakeup loop to
 * pass to `openAgentRuntime`.
 */
export function reminders(clock?: Clock): {
  readonly extension: Extension;
  readonly background: RuntimeBackgroundTask;
} {
  let activeClock = clock ?? systemClock;
  let wake = new AbortController();
  const reschedule = () => wake.abort();

  const tool = defineTool({
    name: "reminder",
    description:
      "Set, list, or cancel reminders to yourself. A due reminder arrives as a new input, even if you are idle. " +
      "Actions: set (note, and either at as an ISO 8601 time with timezone or inMinutes), list, cancel (id).",
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
        if (args.id === undefined) return reply("cancel needs an id.", true);
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
      if (args.note === undefined || args.note.trim() === "") {
        return reply("set needs a note.", true);
      }
      const at = dueTime(args.at, args.inMinutes, activeClock.now());
      if (at === undefined) {
        return reply("set needs at (ISO 8601 timestamp with timezone or Z) or inMinutes.", true);
      }
      const reminder = { id: `r${api.taskId}`, at, note: args.note };
      const outcome = await api.commit(async (tx) => {
        const state = await tx.doc(RemindersDoc, api.conversationId);
        if (state.pending.some((item) => item.id === reminder.id)) return "existing" as const;
        if (state.pending.length >= MAX_PENDING_REMINDERS) return "full" as const;
        state.pending.push(reminder);
        return "added" as const;
      }, context);
      if (outcome === "full") {
        return reply(
          `Too many pending reminders (limit ${MAX_PENDING_REMINDERS}); cancel old ones first.`,
          true,
        );
      }
      reschedule();
      return reply(`Set ${reminder.id} for ${new Date(at).toISOString()}.`);
    },
  });

  const background: RuntimeBackgroundTask = async ({
    harness,
    root,
    lifetime,
    clock: runtimeClock,
  }) => {
    activeClock = runtimeClock;
    const closing = lifetime.signal;
    while (!closing.aborted) {
      wake = new AbortController();
      try {
        const pending =
          (await harness.snapshot(RemindersDoc, root.id, BACKGROUND_CONTEXT))?.pending ?? [];
        for (const due of pending.filter(
          (item) => item.at <= runtimeClock.now() && !closing.aborted,
        )) {
          const iso = new Date(due.at).toISOString();
          await root.submit(
            {
              type: "input",
              content: `<reminder id="${due.id}" scheduled_for="${iso}">\n${due.note}\n</reminder>`,
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
        const next = pending.filter((item) => item.at > runtimeClock.now()).map((item) => item.at);
        await runtimeClock.sleep(
          next.length === 0 ? undefined : Math.min(...next) - runtimeClock.now(),
          AbortSignal.any([closing, wake.signal]),
        );
      } catch (error) {
        if (closing.aborted) return;
        throw error;
      }
    }
  };

  return { extension: defineExtension({ name: "reminders", tools: [tool] }), background };
}

const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function dueTime(
  at: string | undefined,
  inMinutes: number | undefined,
  now: number,
): number | undefined {
  if (inMinutes !== undefined) {
    return Number.isFinite(inMinutes) && inMinutes >= 0 ? now + inMinutes * 60_000 : undefined;
  }
  if (at === undefined || !ISO_WITH_TZ.test(at.trim())) return undefined;
  const parsed = Date.parse(at.trim());
  return Number.isNaN(parsed) ? undefined : parsed;
}
