import { projectImages } from "./image-context.js";
import { buildSummaryRequest, summaryMessage } from "../../prompts/index.js";
import {
  reportedUsage,
  providerResponseComplete,
  reportedGoogleUsage,
  confirmedModelResponse,
} from "../provider-response.js";
import {
  type ReportedUsage,
  type ModelContextMessage,
  type SessionCheckpoint,
  type SessionCommit,
} from "./record.js";

import { randomUUID } from "node:crypto";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { contentText, type AssistantMessage, type Model, type Api } from "@earendil-works/pi-ai";

// Pi coding-agent v0.86.0 defaults, scaled down for models with smaller windows.
const RESERVE_TOKENS = 16_384;
const KEEP_RECENT_TOKENS = 20_000;
export class SummaryResponseError extends Error {
  constructor(readonly response: AssistantMessage) {
    super(`Summarization failed with ${response.stopReason}`);
  }
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

/** One run's committed records and the latest acknowledged checkpoint. The provider sees a
 * transformed request; Agent's full in-memory transcript and SQLite's original rows stay intact. */
export class SessionCompaction {
  private readonly entries: ModelContextMessage[];
  private checkpoint: SessionCheckpoint | undefined;
  private attemptedThrough?: string;
  private forced = false;

  constructor(
    entries: ModelContextMessage[],
    private readonly model: Model<Api>,
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
    const { systemPrompt, prompt, context } = buildSummaryRequest(
      projectImages(messages, false),
      previous,
      prefix,
    );
    const maxTokens = Math.min(Math.floor((prefix ? 0.5 : 0.8) * reserve), this.model.maxTokens);
    if (maxTokens < 1 || textTokens(systemPrompt + prompt) + maxTokens > this.model.contextWindow)
      throw new Error("Summary request has no legal input and output capacity");
    const requestId = randomUUID();
    let inspectedUsage: Promise<{ usage: ReportedUsage; complete: boolean } | null> | undefined;
    const response = await (
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
    ).result();
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
      throw new SummaryResponseError(response);
    const text = contentText(response.content).trim();
    if (!text) throw new Error("Summarization returned an empty summary");
    return { text, requestId };
  }
}
