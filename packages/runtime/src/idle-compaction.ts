import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Models } from "@earendil-works/pi-ai";
import {
  calculateContextTokens,
  estimateMessageTokens,
} from "@earendil-works/pi-ai/utils/estimate";
import {
  AssistantEntry,
  CompactionEntry,
  ConversationBusy,
  GenerationTask,
  SystemEntry,
  UserEntry,
  defineExtension,
  hook,
  type CompactionPolicy,
  type Conversation,
  type EntryId,
  type EntryRecord,
  type ModelRef,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { Clock } from "@palace/clock";
import type { Lifetime } from "./lifetime.ts";
import { builtinRequestId } from "./plugins.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

type IdlePolicy = {
  /** How long after the last request started an idle conversation is compacted. */
  readonly compactAt: number;
  /** The provider's prompt-cache lifetime, after which the checkpoint request would be read uncached and save nothing. */
  readonly cacheGone: number;
  /** Input tokens of the last request (uncached, cache read and cache write) below which compaction is not worth it. */
  readonly minInputTokens: number;
};

/**
 * Every model a new release brings gets this without a code change. Most providers keep a prefix for minutes to an
 * hour; on one that has already dropped it, the checkpoint request pays the reread now instead of when the Agent wakes.
 */
const DEFAULT_POLICY: IdlePolicy = {
  compactAt: 25 * MINUTE,
  cacheGone: 30 * MINUTE,
  minInputTokens: 200_000,
};

/** Overrides of `DEFAULT_POLICY`, keyed `provider/modelId`. */
const IDLE_COMPACTION: Readonly<Record<string, Partial<IdlePolicy>>> = {
  // Durable's background compaction starts near 223k of its 272k window, which leaves 200k too narrow a band.
  "openai/gpt-6.1-sol": { minInputTokens: 150_000 },
  // DeepSeek's V4.1 Flash paper: global KV stays in the persistent cache at least 72 hours.
  "deepseek/deepseek-flash": { compactAt: 70 * HOUR, cacheGone: 72 * HOUR },
};

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
  /** Durable's estimate of the checkpoint request: the last request's tokens, what came after it, and the prompt. */
  readonly checkpointTokens: number;
  /** Above how many tokens Durable starts its own summarizer before a request to `next`; undefined when it never does. */
  readonly summarizesAbove: number | undefined;
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
  if (next?.provider !== provider || next.modelId !== model) return { kind: "off" };
  const policy = { ...DEFAULT_POLICY, ...IDLE_COMPACTION[`${provider}/${model}`] };
  if (usage.input + usage.cacheRead + usage.cacheWrite < policy.minInputTokens)
    return { kind: "off" };
  // Durable would summarize uncached alongside the checkpoint request, paying the reread this is meant to save.
  if (
    observed.summarizesAbove !== undefined &&
    observed.checkpointTokens > observed.summarizesAbove
  )
    return { kind: "off" };
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
 * is reported to the primary conversation, and start `run` after `resume()`; it ends with `lifetime`. `models` and
 * `compaction` are the ones the Harness runs with, so the checkpoint request is measured as Durable measures it.
 */
export function idleCompaction(
  clock: Clock,
  lifetime: Lifetime,
  models: Models,
  compaction: CompactionPolicy,
) {
  const closing = lifetime.signal;
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
      const window = next && models.getModel(next.provider, next.modelId)?.contextWindow;
      const summarizesAbove =
        window === undefined ? undefined : summarizerThreshold(window, compaction);
      if (last === undefined || message === undefined)
        return {
          next,
          last: undefined,
          checkpoint: undefined,
          asked: false,
          compacted: false,
          checkpointTokens: 0,
          summarizesAbove,
        };
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
      const since = view.entries.flatMap((entry, index) =>
        entry.id > last.id ? (view.contributions[index] ?? []) : [],
      );
      const checkpointTokens = [...since, checkpointMessage].reduce(
        (sum, each) => sum + estimateMessageTokens(each),
        calculateContextTokens(message.usage),
      );
      return {
        next,
        last: { id: last.id, message },
        checkpoint,
        asked: (await lookup(builtinRequestId("idle-summary", last.id))) !== undefined,
        compacted: (await lookup(builtinRequestId("idle-compaction", last.id))) !== undefined,
        checkpointTokens,
        summarizesAbove,
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
      const record = await lifetime.orFailure(submission.wait(BACKGROUND_CONTEXT));
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
        await lifetime.orFailure(root.waitForIdle(BACKGROUND_CONTEXT));
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

const checkpointMessage: Message = {
  role: "user",
  content: [{ type: "text", text: CHECKPOINT_PROMPT }],
  timestamp: 0,
};

/**
 * Durable's threshold compaction, which summarizes without the cache: blocking above `contextWindow - reserveTokens`,
 * in the background from `backgroundTokens` below that.
 */
function summarizerThreshold(contextWindow: number, policy: CompactionPolicy): number | undefined {
  if (!policy.enabled || contextWindow <= 0) return undefined;
  return contextWindow - policy.reserveTokens - policy.backgroundTokens;
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
