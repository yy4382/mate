import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
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
  type Extension,
  type ModelRef,
  type SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { RuntimeBackgroundTask } from "@palace/runtime";
import { IDLE_POLICY, type IdlePolicy } from "./idle-policy.ts";

const MINUTE = 60_000;
const CHECKPOINT_PROMPT =
  "[Palace] You have been idle for a while. Write a checkpoint summary of this conversation that you can continue " +
  "from: the goal, constraints and preferences, what is done, what is in progress, key decisions, next steps, and the " +
  "exact paths, names and errors you still need. Do not call tools. Your answer will replace the conversation before it.";

function compactedNote(hasHistoryTools: boolean): string {
  return hasHistoryTools
    ? "The conversation before this point was compacted. Your next message is the checkpoint summary you wrote of " +
        "it; the older records are still readable with history_search and history_read."
    : "The conversation before this point was compacted. Your next message is the checkpoint summary you wrote of it.";
}

type Observation = {
  readonly next: ModelRef | undefined;
  readonly hasHistoryTools: boolean;
  readonly last: { readonly id: EntryId; readonly message: AssistantMessage } | undefined;
  readonly checkpoint: "usable" | "declined" | undefined;
  readonly asked: boolean;
  readonly compacted: boolean;
  readonly checkpointTokens: number;
  readonly summarizesAbove: number | undefined;
};

type Plan =
  | { readonly kind: "off" }
  | { readonly kind: "wait"; readonly until: number }
  | { readonly kind: "ask"; readonly after: EntryId }
  | { readonly kind: "compact"; readonly answer: EntryId; readonly hasHistoryTools: boolean };

function policyFor(provider: string, model: string): IdlePolicy {
  return {
    ...IDLE_POLICY.default,
    ...IDLE_POLICY.providers[provider],
    ...IDLE_POLICY.models[`${provider}/${model}`],
  };
}

function decide(observed: Observation, now: number): Plan {
  const { last, next, hasHistoryTools } = observed;
  if (last === undefined) return { kind: "off" };
  if (observed.checkpoint !== undefined)
    return observed.checkpoint === "usable" && !observed.compacted
      ? { kind: "compact", answer: last.id, hasHistoryTools }
      : { kind: "off" };
  if (observed.asked) return { kind: "off" };
  const { provider, model, usage, timestamp } = last.message;
  if (next?.provider !== provider || next.modelId !== model) return { kind: "off" };
  const policy = policyFor(provider, model);
  const line = observed.summarizesAbove ?? Number.POSITIVE_INFINITY;
  const threshold = Math.min(policy.maxThresholdTokens, policy.thresholdShare * line);
  if (usage.input + usage.cacheRead + usage.cacheWrite < threshold) return { kind: "off" };
  if (
    observed.summarizesAbove !== undefined &&
    observed.checkpointTokens > observed.summarizesAbove
  )
    return { kind: "off" };
  const cacheGone = timestamp + policy.cacheTtlMinutes * MINUTE;
  const compactAt = timestamp + policy.cacheTtlMinutes * MINUTE * policy.compactAfterShare;
  if (now < compactAt) return { kind: "wait", until: compactAt };
  if (now < cacheGone) return { kind: "ask", after: last.id };
  return { kind: "off" };
}

/**
 * Idle compaction of the primary conversation while keeping its prompt cache warm. Returns the `Extension` hook and
 * background loop to pass to `openAgentRuntime`.
 */
export function idleCompaction(): {
  readonly extension: Extension;
  readonly background: RuntimeBackgroundTask;
} {
  let wake = new AbortController();

  const extension = defineExtension({
    name: "idle-compaction",
    hooks: [hook(GenerationTask, { afterResponse: () => wake.abort() })],
  });

  const background: RuntimeBackgroundTask = async ({
    harness,
    root,
    models,
    compaction,
    lifetime,
    clock,
  }) => {
    const closing = lifetime.signal;
    const lookup = (requestId: string): Promise<SubmissionRecord | undefined> =>
      lifetime.orFailure(
        harness.commit((tx) => tx.submissionByRequest(root.id, requestId), BACKGROUND_CONTEXT),
      );
    const usable = async (after: EntryId, record: SubmissionRecord) =>
      record.type === "input" &&
      record.status === "done" &&
      isSummary(await runEntries(root, after, record.answer), record.entry, record.answer);

    async function observe(): Promise<Observation> {
      const agent = await root.agent(BACKGROUND_CONTEXT);
      const next = agent.model;
      const hasHistoryTools = agent.tools.some((tool) => tool.name === "history_search");
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
          hasHistoryTools,
          last: undefined,
          checkpoint: undefined,
          asked: false,
          compacted: false,
          checkpointTokens: 0,
          summarizesAbove,
        };
      const input = view.entries.findLast((entry) => UserEntry.is(entry) && entry.id < last.id);
      const previous =
        input && view.entries.findLast((entry) => AssistantEntry.is(entry) && entry.id < input.id);
      const record = previous && (await lookup(`idle-summary:${previous.id}`));
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
        hasHistoryTools,
        last: { id: last.id, message },
        checkpoint,
        asked: (await lookup(`idle-summary:${last.id}`)) !== undefined,
        compacted: (await lookup(`idle-compaction:${last.id}`)) !== undefined,
        checkpointTokens,
        summarizesAbove,
      };
    }

    async function ask(after: EntryId): Promise<void> {
      let submission;
      try {
        submission = await root.submit(
          {
            type: "input",
            content: CHECKPOINT_PROMPT,
            requestId: `idle-summary:${after}`,
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
        await compact(record.answer, (await observe()).hasHistoryTools);
    }

    async function compact(answer: EntryId, hasHistoryTools: boolean): Promise<void> {
      await root.submit(
        {
          type: "write",
          requestId: `idle-compaction:${answer}`,
          entry: {
            kind: CompactionEntry.kind,
            head: answer,
            data: { reason: "manual" },
            model: [
              {
                role: "user",
                content: [{ type: "text", text: compactedNote(hasHistoryTools) }],
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
        else if (plan.kind === "compact") await compact(plan.answer, plan.hasHistoryTools);
        else
          await clock.sleep(
            plan.kind === "wait" ? plan.until - clock.now() : undefined,
            AbortSignal.any([closing, wake.signal]),
          );
      } catch (error) {
        if (closing.aborted) return;
        throw error;
      }
    }
  };

  return { extension, background };
}

const checkpointMessage: Message = {
  role: "user",
  content: [{ type: "text", text: CHECKPOINT_PROMPT }],
  timestamp: 0,
};

function summarizerThreshold(contextWindow: number, policy: CompactionPolicy): number | undefined {
  if (!policy.enabled || contextWindow <= 0) return undefined;
  return contextWindow - policy.reserveTokens - policy.backgroundTokens;
}

function answerOf(entry: EntryRecord): AssistantMessage | undefined {
  const [message] = entry.model ?? [];
  return message?.role === "assistant" ? message : undefined;
}

async function runEntries(root: Conversation, after: EntryId, answer: EntryId) {
  const page = await root.entries(
    { minEntryId: after, maxEntryId: answer, order: "ascending" },
    8,
    undefined,
    BACKGROUND_CONTEXT,
  );
  return page.items.filter((entry) => !SystemEntry.is(entry));
}

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
