import { randomUUID } from "node:crypto";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
  contentText,
  normalizeContext,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { ModelContextMessage, SessionCheckpoint, SessionCommit } from "./session-record.js";

// Pi coding-agent v0.86.0 defaults, scaled down for models with smaller windows.
const RESERVE_TOKENS = 16_384;
const KEEP_RECENT_TOKENS = 20_000;
const TOOL_RESULT_MAX_CHARS = 2_000;
const SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
const INITIAL_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:
## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]
## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact conversation IDs, task ownership, pending work, tool names, arguments, results, paths and error messages. A tool result is an observation, not permission to repeat a side effect.`;
const UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary. Preserve previous facts, add new progress and decisions, move completed work to Done, and update Next Steps. Preserve exact conversation IDs, task ownership, pending work, tool names, arguments, results, paths and error messages. Remove a prior fact only if it is no longer relevant. Use the same format as the previous summary.`;
const PREFIX_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.
Summarize the prefix to provide context for the retained suffix:
## Original Request
[What was requested in this turn?]

## Early Progress
- [Key decisions, tool observations and work done in the prefix]
## Context for Suffix
- [Information needed to understand the retained recent work, including uncertain effects]

Be concise. Focus on what's needed to understand the kept suffix.`;

export type ReportedUsage = {
  sourceApi: string;
  inputBasis: "includes_cache" | "excludes_cache" | "unknown";
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
};

/** Pi's normalized Usage fills absent provider fields with zero. Inspect only the provider's
 * usage fields at the HTTP boundary; never retain its response body or assume an absent field is 0. */
export function reportedUsage(body: string, api: string): ReportedUsage {
  const reported: ReportedUsage = {
    sourceApi: api,
    inputBasis:
      api === "anthropic-messages"
        ? "excludes_cache"
        : api === "openai-responses" ||
            api === "azure-openai-responses" ||
            api === "openai-codex-responses" ||
            api === "openai-completions"
          ? "includes_cache"
          : "unknown",
  };
  for (const line of body.split("\n")) {
    const data = line.trim().replace(/^data:\s*/, "");
    if (!data.startsWith("{")) continue;
    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    const usage =
      event.response?.usage ?? event.message?.usage ?? event.usage ?? event.usageMetadata;
    if (!usage || typeof usage !== "object") continue;
    const fields = {
      input: usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount,
      output: usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount,
      cacheRead:
        usage.input_tokens_details?.cached_tokens ??
        usage.prompt_tokens_details?.cached_tokens ??
        usage.cache_read_input_tokens ??
        usage.cachedContentTokenCount,
      cacheWrite:
        usage.input_tokens_details?.cache_write_tokens ?? usage.cache_creation_input_tokens,
      reasoning: usage.output_tokens_details?.reasoning_tokens ?? usage.thoughtsTokenCount,
    };
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const) {
      const value = fields[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) reported[key] = value;
    }
  }
  return reported;
}

/** A complete provider error can omit usage. Require a terminal protocol event for SSE;
 * cleanly read HTTP error bodies are also confirmed failures. */
export function providerResponseComplete(body: string, status: number): boolean {
  if (status >= 400 && !body.includes("data:")) return true;
  for (const line of body.split("\n")) {
    const data = line.trim().replace(/^data:\s*/, "");
    if (data === "[DONE]") return true;
    if (!data.startsWith("{")) continue;
    try {
      const event = JSON.parse(data) as { type?: string };
      if (
        [
          "response.completed",
          "response.failed",
          "response.incomplete",
          "message_stop",
          "error",
        ].includes(event.type ?? "")
      )
        return true;
    } catch {
      // Incomplete event is not a terminal response.
    }
  }
  return false;
}

/** Google's Pi adapters do not accept a custom fetch. A positive Pi value proves the SDK
 * reported it; zero still means either a real zero or Pi's fallback for an absent field. */
export function reportedGoogleUsage(message: AssistantMessage): ReportedUsage {
  const usage = message.usage;
  const input = usage.input + usage.cacheRead;
  return {
    sourceApi: message.api,
    inputBasis: "includes_cache",
    ...(Number.isFinite(input) && input > 0 ? { input } : {}),
    ...(usage.output > 0 ? { output: usage.output } : {}),
    ...(usage.cacheRead > 0 ? { cacheRead: usage.cacheRead } : {}),
    ...(usage.reasoning && usage.reasoning > 0 ? { reasoning: usage.reasoning } : {}),
  };
}

/** A header-only or truncated stream is not a confirmed response. For errors, accept only
 * usage fields actually observed from a complete provider body (or Google output evidence). */
export function confirmedModelResponse(
  message: AssistantMessage,
  reported: ReportedUsage | null,
  providerComplete = false,
): boolean {
  return (
    providerComplete ||
    (reported !== null &&
      [
        reported.input,
        reported.output,
        reported.cacheRead,
        reported.cacheWrite,
        reported.reasoning,
      ].some((value) => value !== undefined)) ||
    message.stopReason === "stop" ||
    message.stopReason === "toolUse" ||
    message.stopReason === "length" ||
    ((message.api === "google-generative-ai" || message.api === "google-vertex") &&
      (message.responseId !== undefined || message.usage.totalTokens > 0))
  );
}

function textTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimate(message: AgentMessage): number {
  if (message.role === "user" || message.role === "system" || message.role === "toolResult") {
    const images =
      typeof message.content === "string"
        ? 0
        : message.content.filter((block) => block.type === "image").length;
    return textTokens(contentText(message.content)) + images * 1_200 + 4;
  }
  if (message.role !== "assistant") return 0;
  return (
    textTokens(
      message.content
        .map((block) => {
          if (block.type === "text") return block.text;
          if (block.type === "thinking") return block.thinking;
          if (block.type === "toolCall") return block.name + JSON.stringify(block.arguments);
          return "";
        })
        .join(""),
    ) + 4
  );
}

function contextTokens(entries: ModelContextMessage[], throughId?: string): number {
  const anchor = throughId ? entries.findIndex((entry) => entry.id === throughId) + 1 : 0;
  for (let i = entries.length - 1; i >= anchor; i--) {
    const message = entries[i]!.message;
    if (
      message.role !== "assistant" ||
      message.stopReason === "error" ||
      message.stopReason === "aborted"
    )
      continue;
    const usage = message.usage;
    const total =
      usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    if (total > 0)
      return total + entries.slice(i + 1).reduce((sum, entry) => sum + estimate(entry.message), 0);
  }
  return entries.reduce((sum, entry) => sum + estimate(entry.message), 0);
}

function serialize(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const content = contentText(message.content, "");
      if (content) parts.push(`[User]: ${content}`);
    } else if (message.role === "assistant") {
      const thinking = message.content
        .filter((block) => block.type === "thinking")
        .map((block) => block.thinking);
      const calls = message.content
        .filter((block) => block.type === "toolCall")
        .map(
          (block) =>
            `${block.name}(${Object.entries(block.arguments)
              .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
              .join(", ")})`,
        );
      if (thinking.length) parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
      if (message.content.some((block) => block.type === "text"))
        parts.push(`[Assistant]: ${contentText(message.content)}`);
      if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    } else if (message.role === "toolResult") {
      const content = contentText(message.content, "");
      if (content)
        parts.push(
          `[Tool result]: ${content.length <= TOOL_RESULT_MAX_CHARS ? content : `${content.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${content.length - TOOL_RESULT_MAX_CHARS} more characters truncated]`}`,
        );
    }
  }
  return parts.join("\n\n");
}

function summaryMessage(summary: string): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `[会话压缩摘要]\n${summary}` }],
    timestamp: 0,
  };
}

/** One run's committed records and the latest acknowledged checkpoint. The provider sees a
 * transformed request; Agent's full in-memory transcript and SQLite's original rows stay intact. */
export class SessionCompaction {
  private readonly entries: ModelContextMessage[];
  private checkpoint: SessionCheckpoint | undefined;
  private attemptedThrough?: string;
  private forced = false;

  constructor(
    entries: ModelContextMessage[],
    private readonly model: Model<any>,
    private readonly apiKey: string,
    private readonly stream: StreamFn,
    private readonly commit: (entry: SessionCommit) => Promise<void>,
  ) {
    this.entries = entries.slice();
    this.checkpoint = entries.find((entry) => entry.checkpoint)?.checkpoint;
  }

  record(id: string, message: ModelContextMessage["message"]): void {
    this.entries.push({ id, message, actionScopeId: "" });
  }

  forceAfterOverflow(): void {
    this.forced = true;
  }

  async transform(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
    const system = messages.filter((message) => message.role === "system");
    const activeStart = this.checkpoint
      ? this.entries.findIndex((entry) => entry.id === this.checkpoint!.firstKeptEntryId)
      : 0;
    if (activeStart < 0) throw new Error("Compaction checkpoint lost its retained entry");
    const active = this.entries.slice(activeStart);
    const summary = this.checkpoint ? [summaryMessage(this.checkpoint.summary)] : [];
    const current = [...system, ...summary, ...active.map((entry) => entry.message)];
    const reserve = Math.min(RESERVE_TOKENS, Math.floor(this.model.contextWindow * 0.2));
    const keep = Math.min(
      KEEP_RECENT_TOKENS,
      Math.floor((this.model.contextWindow - reserve) * 0.5),
    );
    const estimateBefore =
      contextTokens(active, this.checkpoint?.throughEntryId) +
      [...system, ...summary].reduce((sum, message) => sum + estimate(message), 0);
    const forced = this.forced;
    this.forced = false;
    if (!forced && estimateBefore <= this.model.contextWindow - reserve) return current;
    const latestId = active.at(-1)?.id;
    if (!latestId || latestId === this.attemptedThrough)
      throw new Error("Context still exceeds capacity after compaction");
    this.attemptedThrough = latestId;

    let accumulated = 0;
    let cut = -1;
    for (let i = active.length - 1; i >= 0; i--) {
      accumulated += estimate(active[i]!.message);
      if (accumulated < keep) continue;
      for (let candidate = i; candidate < active.length; candidate++) {
        if (active[candidate]!.message.role !== "toolResult") {
          cut = candidate;
          break;
        }
      }
      if (cut < 0) {
        for (let candidate = i - 1; candidate >= 0; candidate--) {
          if (active[candidate]!.message.role !== "toolResult") {
            cut = candidate;
            break;
          }
        }
      }
      break;
    }
    if (cut < 0 && forced) {
      cut = active.findIndex((entry, index) => index > 0 && entry.message.role !== "toolResult");
    }
    if (cut <= 0) throw new Error("No legal compaction range fits the retained context");
    let turnStart = cut;
    while (turnStart > 0 && active[turnStart]!.message.role !== "user") turnStart--;
    const split =
      active[cut]!.message.role !== "user" && active[turnStart]!.message.role === "user";
    const historyEnd = split ? turnStart : cut;
    const history = active.slice(0, historyEnd).map((entry) => entry.message);
    const prefix = split ? active.slice(turnStart, cut).map((entry) => entry.message) : [];
    if (!history.length && !prefix.length)
      throw new Error("No messages can be summarized at this boundary");
    let nextSummary = this.checkpoint?.summary ?? "No prior history.";
    const summaryRequestIds: string[] = [];
    if (history.length) {
      const result = await this.summarize(
        history,
        this.checkpoint?.summary,
        false,
        reserve,
        signal,
      );
      nextSummary = result.text;
      summaryRequestIds.push(result.requestId);
    }
    if (prefix.length) {
      const result = await this.summarize(prefix, undefined, true, reserve, signal);
      nextSummary += `\n\n---\n\n**Turn Context (split turn):**\n\n${result.text}`;
      summaryRequestIds.push(result.requestId);
    }
    const retained = active.slice(cut);
    const resulting = [
      ...system,
      summaryMessage(nextSummary),
      ...retained.map((entry) => entry.message),
    ];
    if (
      resulting.reduce((sum, message) => sum + estimate(message), 0) >
      this.model.contextWindow - reserve
    )
      throw new Error("Compacted context still exceeds model capacity");
    const checkpoint: SessionCheckpoint = {
      kind: "compaction",
      id: randomUUID(),
      firstKeptEntryId: retained[0]!.id,
      throughEntryId: latestId,
      summary: nextSummary,
      tokensBefore: estimateBefore,
      summaryRequestIds,
    };
    await this.commit(checkpoint);
    this.checkpoint = checkpoint;
    return resulting;
  }

  private async summarize(
    messages: AgentMessage[],
    previous: string | undefined,
    prefix: boolean,
    reserve: number,
    signal?: AbortSignal,
  ): Promise<{ text: string; requestId: string }> {
    const conversation = serialize(messages);
    const prompt = `<conversation>\n${conversation}\n</conversation>\n\n${previous ? `<previous-summary>\n${previous}\n</previous-summary>\n\n` : ""}${prefix ? PREFIX_PROMPT : previous ? UPDATE_PROMPT : INITIAL_PROMPT}`;
    const maxTokens = Math.min(Math.floor((prefix ? 0.5 : 0.8) * reserve), this.model.maxTokens);
    if (maxTokens < 1 || textTokens(SYSTEM_PROMPT + prompt) + maxTokens > this.model.contextWindow)
      throw new Error("Summary request has no legal input and output capacity");
    const context = normalizeContext({
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
      ],
    });
    const requestId = randomUUID();
    let inspectedUsage: Promise<{ usage: ReportedUsage; complete: boolean } | null> | undefined;
    const response = (await (
      await this.stream(this.model, context, {
        apiKey: this.apiKey,
        env: {},
        ...(signal ? { signal } : {}),
        maxTokens,
        cacheRetention: "none",
        sessionId: requestId,
        ...(this.model.api === "google-generative-ai" || this.model.api === "google-vertex"
          ? {}
          : {
              fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                const response = await fetch(input, init);
                inspectedUsage = response
                  .clone()
                  .text()
                  .then((body) => ({
                    usage: reportedUsage(body, this.model.api),
                    complete: providerResponseComplete(body, response.status),
                  }))
                  .catch(() => null);
                return response;
              },
            }),
      })
    ).result()) as AssistantMessage;
    const rawUsage = await inspectedUsage;
    if (confirmedModelResponse(response, rawUsage?.usage ?? null, rawUsage?.complete ?? false))
      await this.commit({
        kind: "summary_usage",
        id: requestId,
        stopReason: response.stopReason,
        usage: JSON.parse(JSON.stringify(response.usage)),
        reportedUsage:
          rawUsage?.usage ??
          (this.model.api === "google-generative-ai" || this.model.api === "google-vertex"
            ? reportedGoogleUsage(response)
            : null),
      });
    if (
      response.stopReason !== "stop" ||
      response.content.some((block) => block.type === "toolCall")
    )
      throw new Error(`Summarization failed with ${response.stopReason}`);
    const text = contentText(response.content).trim();
    if (!text) throw new Error("Summarization returned an empty summary");
    return { text, requestId };
  }
}
