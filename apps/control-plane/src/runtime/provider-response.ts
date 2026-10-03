import { z } from "zod";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ReportedUsage } from "./session/record.js";

// Provider envelopes are intentionally open: inspect known fields without dropping extensions.
const providerObjectSchema = z.record(z.string(), z.unknown());

function record(value: unknown) {
  const parsed = providerObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function providerEvent(data: string) {
  try {
    return record(JSON.parse(data));
  } catch {
    return undefined;
  }
}

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
    const event = providerEvent(data);
    if (!event) continue;
    const usage = record(
      record(event.response)?.usage ??
        record(event.message)?.usage ??
        event.usage ??
        event.usageMetadata,
    );
    if (!usage) continue;
    const fields = {
      input: usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokenCount,
      output: usage.output_tokens ?? usage.completion_tokens ?? usage.candidatesTokenCount,
      cacheRead:
        record(usage.input_tokens_details)?.cached_tokens ??
        record(usage.prompt_tokens_details)?.cached_tokens ??
        usage.cache_read_input_tokens ??
        usage.cachedContentTokenCount,
      cacheWrite:
        record(usage.input_tokens_details)?.cache_write_tokens ?? usage.cache_creation_input_tokens,
      reasoning: record(usage.output_tokens_details)?.reasoning_tokens ?? usage.thoughtsTokenCount,
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
      const event = providerEvent(data);
      if (
        [
          "response.completed",
          "response.failed",
          "response.incomplete",
          "message_stop",
          "error",
        ].includes(typeof event?.type === "string" ? event.type : "")
      )
        return true;
    } catch {
      // Incomplete event is not a terminal response.
    }
  }
  return false;
}

/** OpenAI SDK 7 aborts the response after Pi consumes a terminal error event. Preserve
 * already received terminal evidence even when reading the response clone then fails. */
export async function inspectProviderResponse(response: Response, api: string) {
  const reader = response.clone().body?.getReader();
  const decoder = new TextDecoder();
  let body = "";
  try {
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    }
  } catch {
    // Only fully delimited SSE frames survive cancellation. The HTTP-error shortcut
    // requires a clean read, and an unfinished trailing frame carries no evidence.
    body = body.replace(/\r\n?/g, "\n").split("\n\n").slice(0, -1).join("\n\n");
    if (!body.includes("data:") || !providerResponseComplete(body, 200)) return null;
  } finally {
    reader?.releaseLock();
  }
  return {
    usage: reportedUsage(body, api),
    complete: providerResponseComplete(body, response.status),
  };
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
