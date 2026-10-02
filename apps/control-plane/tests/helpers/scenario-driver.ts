import {
  attachmentSummarySchema,
  ownerMessagePageSchema,
  ownerMessageSchema,
  ownerTaskSchema,
} from "@mate/protocol/owner";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { PreparedScenarioAgent, createScenarioEnvironment } from "./scenario-environment.js";
import type { AgentActivityEvent } from "../../src/runtime/activity.js";
import { readMessageRuns } from "./scenario-facts.js";

// Activity has no shared Zod export; validate its existing runtime contract at this read boundary.
const activityEventSchema = z.looseObject({
  sequence: z.number(),
  kind: z.string(),
  referenceId: z.string().nullable(),
  summary: z.string(),
  at: z.number(),
  detail: z.unknown().optional(),
}) satisfies z.ZodType<AgentActivityEvent>;
const activityPageSchema = z.looseObject({
  events: z.array(activityEventSchema),
  nextBefore: z.number().nullable(),
});
const messageTargetSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  runId: z.string().optional(),
  afterActivity: z.number(),
  message: ownerMessageSchema,
});
export type ScenarioMessageTarget = z.output<typeof messageTargetSchema>;
export type ScenarioWaitOptions = { timeoutMs?: number; signal?: AbortSignal };
const taskTargetSchema = ownerTaskSchema.pick({
  id: true,
  messageId: true,
  channelId: true,
  ownerAgentId: true,
  status: true,
});
const deliveredMessageSchema = ownerMessageSchema.pick({
  id: true,
  channelId: true,
  rootId: true,
  author: true,
  text: true,
});

export class ScenarioWaitError extends Error {
  constructor(
    readonly label: string,
    readonly lastFacts: unknown,
    cause: unknown,
  ) {
    super(`Scenario wait failed: ${label}; last facts: ${JSON.stringify(lastFacts)}`, { cause });
  }
}

/** A deadline applies to the observer as well as the polling interval. */
export async function waitForScenario<T>(
  label: string,
  read: (signal: AbortSignal) => T | Promise<T>,
  matches: (facts: T) => boolean,
  options: ScenarioWaitOptions = {},
) {
  const timeoutMs = z
    .number()
    .int()
    .positive()
    .parse(options.timeoutMs ?? 5000);
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  if (signal.aborted) throw new ScenarioWaitError(label, undefined, signal.reason);
  let lastFacts: T | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    for (;;) {
      signal.throwIfAborted();
      lastFacts = await Promise.race([Promise.resolve().then(() => read(signal)), cancelled]);
      signal.throwIfAborted();
      if (matches(lastFacts)) return lastFacts;
      await delay(25, undefined, { signal });
    }
  } catch (cause) {
    throw new ScenarioWaitError(label, lastFacts, cause);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

/** Owner-only inputs and observations. Agent tools remain inside the real Pi loop. */
export function createScenarioDriver(
  environment: Awaited<ReturnType<typeof createScenarioEnvironment>>,
) {
  async function json<S extends z.core.$ZodType>(path: string, schema: S, signal?: AbortSignal) {
    return z.parse(
      schema,
      await (await environment.request(path, signal ? { signal } : {})).json(),
    );
  }
  function activityPage(agentId: string, before: number | null, signal?: AbortSignal) {
    return json(
      `/api/owner/agents/${agentId}/activity?limit=100&detail=1${before === null ? "" : `&before=${before}`}`,
      activityPageSchema,
      signal,
    );
  }
  async function activity(agentId: string, after = 0, signal?: AbortSignal) {
    const events: z.output<typeof activityPageSchema>["events"] = [];
    let before: number | null = null;
    do {
      const page = await activityPage(agentId, before, signal);
      events.push(...page.events.filter((event) => event.sequence > after));
      before = page.events.some((event) => event.sequence <= after) ? null : page.nextBefore;
    } while (before !== null);
    return events.sort((left, right) => left.sequence - right.sequence);
  }
  async function observe(agent: PreparedScenarioAgent) {
    const events = await activity(agent.summary.id);
    return {
      agentId: agent.summary.id,
      sessionId: agent.summary.sessionId,
      afterActivity: events.at(-1)?.sequence ?? 0,
    };
  }
  function messagePage(channelId: string, before: string | null, signal?: AbortSignal) {
    return json(
      `/api/owner/channels/${channelId}/messages?limit=100${before === null ? "" : `&before=${before}`}`,
      ownerMessagePageSchema,
      signal,
    );
  }
  async function messages(channelId: string, signal?: AbortSignal) {
    const result: z.output<typeof ownerMessageSchema>[] = [];
    let before: string | null = null;
    do {
      const page = await messagePage(channelId, before, signal);
      result.push(...page.messages);
      before = page.nextBefore;
    } while (before !== null);
    return result.sort((left, right) =>
      BigInt(left.order) < BigInt(right.order)
        ? -1
        : BigInt(left.order) > BigInt(right.order)
          ? 1
          : 0,
    );
  }
  function thread(channelId: string, rootId: string, signal?: AbortSignal) {
    return json(
      `/api/owner/channels/${channelId}/threads/${rootId}`,
      z.object({ root: ownerMessageSchema, replies: z.array(ownerMessageSchema) }),
      signal,
    );
  }
  async function tasks(signal?: AbortSignal) {
    return (await json("/api/owner/tasks", z.object({ tasks: z.array(ownerTaskSchema) }), signal))
      .tasks;
  }
  async function attachments(channelId: string, signal?: AbortSignal) {
    return (
      await json(
        `/api/owner/channels/${channelId}/attachments`,
        z.object({ attachments: z.array(attachmentSummarySchema) }),
        signal,
      )
    ).attachments;
  }
  return {
    activity,
    observe,
    messages,
    thread,
    tasks,
    attachments,
    async sendOwnerMessage(agent: PreparedScenarioAgent, text: string) {
      const cursor = await observe(agent);
      const message = ownerMessageSchema.parse(
        await (
          await environment.request(`/api/owner/channels/${agent.channelId}/messages`, {
            method: "POST",
            body: { text },
          })
        ).json(),
      );
      return { ...cursor, message };
    },
    async waitForRun(
      target: ScenarioMessageTarget,
      state: "running" | "completed" | "failed",
      options?: ScenarioWaitOptions,
    ) {
      const parsed = messageTargetSchema.parse(target);
      function matchingRun(facts: {
        runs: ReturnType<typeof readMessageRuns>;
        events: z.output<typeof activityEventSchema>[];
      }) {
        return facts.runs.find(
          (run) =>
            (parsed.runId === undefined || run.id === parsed.runId) &&
            run.sessionId === parsed.sessionId &&
            run.state === state &&
            facts.events.some(
              (event) => event.kind === "run.started" && event.referenceId === run.id,
            ) &&
            (state === "running" ||
              facts.events.some(
                (event) =>
                  event.referenceId === run.id &&
                  (state === "completed"
                    ? event.kind === "run.completed"
                    : event.kind === "run.failed" || event.kind === "run.interrupted"),
              )),
        );
      }
      const facts = await waitForScenario(
        `Agent ${parsed.agentId}, message ${parsed.message.id}, run ${parsed.runId ?? "for this message"} ${state} after activity ${parsed.afterActivity}`,
        async (signal) => ({
          runs: readMessageRuns(environment.directory, parsed.agentId, parsed.message.id),
          events: await activity(parsed.agentId, parsed.afterActivity, signal),
        }),
        (observed) => matchingRun(observed) !== undefined,
        options,
      );
      const run = matchingRun(facts);
      if (!run) throw new Error("Matched run was missing from the observed facts");
      return run;
    },
    async waitForTask(target: z.input<typeof taskTargetSchema>, options?: ScenarioWaitOptions) {
      const expected = taskTargetSchema.parse(target);
      const matches = (task: z.output<typeof ownerTaskSchema>) =>
        isDeepStrictEqual(taskTargetSchema.parse(task), expected);
      const observed = await waitForScenario(
        `task ${expected.id}: ${JSON.stringify(expected)}`,
        tasks,
        (facts) => facts.some(matches),
        options,
      );
      const task = observed.find(matches);
      if (!task) throw new Error("Matched task was missing from the observed facts");
      return task;
    },
    async waitForMessage(
      target: z.input<typeof deliveredMessageSchema>,
      options?: ScenarioWaitOptions,
    ) {
      const expected = deliveredMessageSchema.parse(target);
      const matches = (message: z.output<typeof ownerMessageSchema>) =>
        isDeepStrictEqual(deliveredMessageSchema.parse(message), expected);
      const observed = await waitForScenario(
        `message ${expected.id}: ${JSON.stringify(expected)}`,
        async (signal) =>
          expected.rootId === null
            ? messages(expected.channelId, signal)
            : (await thread(expected.channelId, expected.rootId, signal)).replies,
        (facts) => facts.some(matches),
        options,
      );
      const message = observed.find(matches);
      if (!message) throw new Error("Matched message was missing from the observed facts");
      return message;
    },
    async assertAttachment(input: {
      agent: PreparedScenarioAgent;
      channelId: string;
      attachmentId: string;
      path: string;
      expectedBytes: Uint8Array;
    }) {
      const attachment = (await attachments(input.channelId)).find(
        (item) => item.id === input.attachmentId,
      );
      assert.ok(
        attachment,
        `Attachment ${input.attachmentId} is absent from channel ${input.channelId}`,
      );
      assert.equal(attachment.channelId, input.channelId);
      assert.deepEqual(attachment.uploader, { kind: "agent", id: input.agent.summary.id });
      const response = await environment.request(
        `/api/owner/channels/${input.channelId}/attachments/${input.attachmentId}/content`,
      );
      const bytes = Buffer.from(await response.arrayBuffer());
      const workspaceBytes = await readFile(resolve(input.agent.workspace, input.path));
      assert.deepEqual(
        bytes,
        Buffer.from(input.expectedBytes),
        "Owner attachment differs from the synthetic expected bytes",
      );
      assert.deepEqual(
        workspaceBytes,
        bytes,
        "Owner attachment differs from the actual workspace file",
      );
      assert.equal(attachment.size, bytes.length);
      assert.equal(attachment.sha256, createHash("sha256").update(bytes).digest("hex"));
      return { attachment, bytes, workspaceBytes };
    },
  };
}
