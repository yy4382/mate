import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  CompactionEntry,
  ConversationBusy,
  GenerationTask,
  SystemEntry,
  UserEntry,
  defineExtension,
  hook,
  type Conversation,
  type EntryId,
  type EntryRecord,
  type ModelRef,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { Clock } from "@palace/clock";
import { builtinRequestId } from "./plugins.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Per model, keyed `provider/modelId`: `compactAt` is how long after the last request started an idle conversation is
 * compacted, `cacheGone` the provider's guaranteed prompt-cache lifetime, after which the checkpoint request would be
 * read uncached and save nothing. A model without an entry is never idle-compacted.
 */
const IDLE_COMPACTION: Readonly<Record<string, { compactAt: number; cacheGone: number }>> = {
  // OpenAI keeps a prefix at least 30 minutes; 6.1 sol is slow, so leave margin.
  "openai/gpt-6.1-sol": { compactAt: 25 * MINUTE, cacheGone: 30 * MINUTE },
  // DeepSeek's V4.1 Flash paper: global KV stays in the persistent cache at least 72 hours.
  "deepseek/deepseek-flash": { compactAt: 70 * HOUR, cacheGone: 72 * HOUR },
};

/** Input tokens of the last request (uncached, cache read and cache write) below which compaction is not worth it. */
const MIN_INPUT_TOKENS = 200_000;

const CHECKPOINT_PROMPT =
  "[Palace] You have been idle for a while. Write a checkpoint summary of this conversation that you can continue " +
  "from: the goal, constraints and preferences, what is done, what is in progress, key decisions, next steps, and the " +
  "exact paths, names and errors you still need. Do not call tools. Your answer will replace the conversation before it.";

const COMPACTED_NOTE =
  "The conversation before this point was compacted. Your next message is the checkpoint summary you wrote of it; " +
  "the older records are still readable with history_search and history_read.";

/** One read of the primary conversation while it is idle; everything `decide` needs. */
type Observation = {
  /** The model the next request goes to. */
  readonly next: ModelRef | undefined;
  /** The newest answer after the head marker: the last request, whose cache is the one to reuse. */
  readonly last: { readonly id: EntryId; readonly message: AssistantMessage } | undefined;
  /** When `last` ends the run of a checkpoint request: whether it is a summary to start from. */
  readonly checkpoint: "usable" | "declined" | undefined;
  /** A checkpoint was already asked after `last`. */
  readonly asked: boolean;
  /** The compaction starting at `last` was already admitted. */
  readonly compacted: boolean;
};

type Plan =
  | { readonly kind: "off" }
  | { readonly kind: "wait"; readonly until: number }
  | { readonly kind: "ask"; readonly after: EntryId }
  | { readonly kind: "compact"; readonly answer: EntryId };

/** Every rule of idle compaction, in order. */
function decide(observed: Observation, now: number): Plan {
  const { last, next } = observed;
  if (last === undefined) return { kind: "off" };
  if (observed.checkpoint !== undefined)
    return observed.checkpoint === "usable" && !observed.compacted
      ? { kind: "compact", answer: last.id }
      : { kind: "off" };
  // Asked once already: its input was withdrawn or ended without an answer. Asking again would dedup to nothing.
  if (observed.asked) return { kind: "off" };
  const { provider, model, usage, timestamp } = last.message;
  const policy = IDLE_COMPACTION[`${provider}/${model}`];
  if (policy === undefined || next?.provider !== provider || next.modelId !== model)
    return { kind: "off" };
  if (usage.input + usage.cacheRead + usage.cacheWrite < MIN_INPUT_TOKENS) return { kind: "off" };
  // pi-ai stamps an answer with the wall-clock time its request started, which is when the provider cached it.
  if (now < timestamp + policy.compactAt)
    return { kind: "wait", until: timestamp + policy.compactAt };
  if (now < timestamp + policy.cacheGone) return { kind: "ask", after: last.id };
  return { kind: "off" };
}

/**
 * The primary conversation's idle compaction. When it has been idle for its model's delay after a large request, the
 * Agent is asked for a checkpoint summary through an ordinary input, so the request continues the cached prefix; the
 * context then starts at that answer. Install `extension` in the primary conversation only, since an assistant's answer
 * is reported to the primary conversation, and start `run` after `resume()`; it ends when `closing` aborts.
 */
export function idleCompaction(clock: Clock, closing: AbortSignal) {
  let wake = new AbortController();

  const extension = defineExtension({
    name: "idle-compaction",
    hooks: [hook(GenerationTask, { afterResponse: () => wake.abort() })],
  });

  /**
   * One pass per quiet state: wait until idle, observe, act. Nothing is stored outside Durable's records, and each act
   * is deduplicated by its requestId, so a reopened runtime derives the same step from where the last one stopped.
   */
  async function run(
    root: Conversation,
    lookup: (requestId: string) => Promise<SubmissionRecord | undefined>,
  ): Promise<void> {
    const usable = async (after: EntryId, record: SubmissionRecord) =>
      record.type === "input" &&
      record.status === "done" &&
      isSummary(await runEntries(root, after, record.answer), record.entry, record.answer);

    async function observe(): Promise<Observation> {
      const next = (await root.agent(BACKGROUND_CONTEXT)).model;
      const view = await root.context(BACKGROUND_CONTEXT);
      const after = view.head?.id ?? Number.NEGATIVE_INFINITY;
      const last = view.entries.findLast((entry) => AssistantEntry.is(entry) && entry.id > after);
      const message = last === undefined ? undefined : answerOf(last);
      if (last === undefined || message === undefined)
        return { next, last: undefined, checkpoint: undefined, asked: false, compacted: false };
      // A checkpoint input is keyed by the answer before it, and its run may hold a tool round before `last`.
      const input = view.entries.findLast((entry) => UserEntry.is(entry) && entry.id < last.id);
      const previous =
        input && view.entries.findLast((entry) => AssistantEntry.is(entry) && entry.id < input.id);
      const record = previous && (await lookup(builtinRequestId("idle-summary", previous.id)));
      const checkpoint =
        previous === undefined || record === undefined || record.entry !== input?.id
          ? undefined
          : record.status === "done" &&
              record.answer === last.id &&
              (await usable(previous.id, record))
            ? "usable"
            : "declined";
      return {
        next,
        last: { id: last.id, message },
        checkpoint,
        asked: (await lookup(builtinRequestId("idle-summary", last.id))) !== undefined,
        compacted: (await lookup(builtinRequestId("idle-compaction", last.id))) !== undefined,
      };
    }

    /**
     * Ask, then compact as soon as the checkpoint input settles. Waiting for idle instead would miss it: a real input
     * placed at the checkpoint run's final boundary starts the next run in the same commit, and its answer then is the
     * newest one.
     */
    async function ask(after: EntryId): Promise<void> {
      let submission;
      try {
        submission = await root.submit(
          {
            type: "input",
            content: CHECKPOINT_PROMPT,
            requestId: builtinRequestId("idle-summary", after),
            whenBusy: "reject",
          },
          BACKGROUND_CONTEXT,
        );
      } catch (error) {
        if (error instanceof ConversationBusy) return;
        throw error;
      }
      const record = await submission.wait(BACKGROUND_CONTEXT);
      if (record.type === "input" && record.status === "done" && (await usable(after, record)))
        await compact(record.answer);
    }

    /**
     * Start the context at the checkpoint answer with a head marker. Through admission, it is placed at once when idle,
     * otherwise at the next boundary, and settled stale when a Durable compaction has moved the head past the answer.
     */
    async function compact(answer: EntryId): Promise<void> {
      await root.submit(
        {
          type: "write",
          requestId: builtinRequestId("idle-compaction", answer),
          entry: {
            kind: CompactionEntry.kind,
            head: answer,
            data: { reason: "manual" },
            model: [
              {
                role: "user",
                content: [{ type: "text", text: COMPACTED_NOTE }],
                timestamp: clock.now(),
              },
            ],
          },
        },
        BACKGROUND_CONTEXT,
      );
    }

    while (!closing.aborted) {
      wake = new AbortController();
      try {
        await root.waitForIdle(BACKGROUND_CONTEXT);
        const plan = decide(await observe(), clock.now());
        if (plan.kind === "ask") await ask(plan.after);
        else if (plan.kind === "compact") await compact(plan.answer);
        else
          await clock.sleep(
            plan.kind === "wait" ? plan.until - clock.now() : undefined,
            AbortSignal.any([closing, wake.signal]),
          );
      } catch (error) {
        // The runtime closed or its storage failed while this pass was working. Either way, this loop is done.
        if (closing.aborted) return;
        throw error;
      }
    }
  }

  return { extension, run };
}

function answerOf(entry: EntryRecord): AssistantMessage | undefined {
  const [message] = entry.model ?? [];
  return message?.role === "assistant" ? message : undefined;
}

/** The entries from the answer `after` through `answer`, oldest first, without prompt changes. */
async function runEntries(root: Conversation, after: EntryId, answer: EntryId) {
  const page = await root.entries(
    { minEntryId: after, maxEntryId: answer, order: "ascending" },
    8,
    undefined,
    BACKGROUND_CONTEXT,
  );
  return page.items.filter((entry) => !SystemEntry.is(entry));
}

/**
 * Whether a checkpoint run's entries make a summary: the checkpoint input alone, answered at once with a clean stop,
 * no tool call and some text, the test Durable's own summarizer applies. A tool round or a real input in the same run
 * declines it.
 */
function isSummary(entries: readonly EntryRecord[], input: EntryId, answer: EntryId): boolean {
  const [, first, last, ...rest] = entries;
  const message = last === undefined ? undefined : answerOf(last);
  return (
    first?.id === input &&
    last?.id === answer &&
    rest.length === 0 &&
    message !== undefined &&
    message.stopReason === "stop" &&
    !message.content.some((part) => part.type === "toolCall") &&
    message.content.some((part) => part.type === "text" && part.text.trim() !== "")
  );
}
