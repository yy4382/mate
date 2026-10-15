import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { StorageWrite, Storage, DocumentId } from "@earendil-works/pi-durable";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { copyJson } from "@earendil-works/chord";
import { reportedUsageSchema, type ReportedUsage } from "./provider-response.js";

export const usageObservationSchema = z.object({
  confirmed: z.boolean(),
  reported: reportedUsageSchema.nullable(),
});

export const tokenNameSchema = z.enum([
  "uncachedInput",
  "cacheRead",
  "cacheWrite",
  "allInput",
  "output",
  "total",
  "reasoningOutput",
]);
type TokenName = z.infer<typeof tokenNameSchema>;
export const tokenNames = tokenNameSchema.options;

export function zeroTokenCounts() {
  return {
    uncachedInput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    allInput: 0,
    output: 0,
    total: 0,
    reasoningOutput: 0,
  };
}

export function tokensOf(reported: ReportedUsage | null): Record<TokenName, number | null> {
  const absent = {
    uncachedInput: null,
    cacheRead: null,
    cacheWrite: null,
    allInput: null,
    output: null,
    total: null,
    reasoningOutput: null,
  };
  if (!reported) return absent;
  const cacheRead = reported.cacheRead ?? null;
  const cacheWrite = reported.cacheWrite ?? null;
  const output = reported.output ?? null;
  let uncachedInput: number | null = null;
  let allInput: number | null = null;
  if (reported.input !== undefined) {
    if (reported.inputBasis === "excludes_cache") {
      uncachedInput = reported.input;
      if (cacheRead !== null && cacheWrite !== null)
        allInput = reported.input + cacheRead + cacheWrite;
    } else if (reported.inputBasis === "includes_cache") {
      // A contradictory provider breakdown is not a valid source for derived totals or rates.
      if (
        (cacheRead === null || cacheRead <= reported.input) &&
        (cacheWrite === null || cacheWrite <= reported.input) &&
        (cacheRead === null || cacheWrite === null || cacheRead + cacheWrite <= reported.input)
      )
        allInput = reported.input;
      if (allInput !== null && cacheRead !== null && cacheWrite !== null)
        uncachedInput = reported.input - cacheRead - cacheWrite;
    }
  }
  return {
    uncachedInput,
    cacheRead,
    cacheWrite,
    allInput,
    output,
    total: allInput !== null && output !== null ? allInput + output : null,
    reasoningOutput: reported.reasoning ?? null,
  };
}

const tokenCountsSchema = z.record(tokenNameSchema, z.number().nonnegative());
const coverageSchema = z.object({
  requestCount: z.number().int().nonnegative(),
  known: tokenCountsSchema,
  unsafe: z.record(tokenNameSchema, z.boolean()),
  hitKnown: z.number().int().nonnegative(),
  hitInput: z.number().nonnegative(),
  hitRead: z.number().nonnegative(),
});
export const summaryAvailabilitySchema = z.object({ groups: z.record(z.string(), coverageSchema) });
export const summaryAvailabilityKind = "mate.usage-availability";
export type SummaryCoverage = z.infer<typeof coverageSchema>;

export const nativeUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number().optional(),
});
export function nativeTokens(usage: z.output<typeof nativeUsageSchema>) {
  const allInput = usage.input + usage.cacheRead + usage.cacheWrite;
  return {
    uncachedInput: usage.input,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    allInput,
    output: usage.output,
    total: allInput + usage.output,
    reasoningOutput: usage.reasoning ?? 0,
  };
}

function emptyCoverage(): SummaryCoverage {
  return {
    requestCount: 0,
    known: zeroTokenCounts(),
    unsafe: {
      uncachedInput: false,
      cacheRead: false,
      cacheWrite: false,
      allInput: false,
      output: false,
      total: false,
      reasoningOutput: false,
    },
    hitKnown: 0,
    hitInput: 0,
    hitRead: 0,
  };
}

/** Availability belongs to the native response commit, never an independent request ledger. */
export class UsageObservations {
  private readonly pending: {
    id: string;
    message: AssistantMessage;
    confirmed: boolean;
    reported: ReportedUsage | null;
    request: {
      summary: boolean;
      providerSessionId: string | undefined;
      thinkingLevel: ModelThinkingLevel;
    };
  }[] = [];

  capture(
    message: AssistantMessage,
    reported: ReportedUsage | null,
    confirmed: boolean,
    request: {
      summary: boolean;
      providerSessionId: string | undefined;
      thinkingLevel: ModelThinkingLevel;
    },
  ) {
    // Native compaction never records an aborted response. Keeping it pending could
    // associate the next completed summary with this interrupted request instead.
    if (request.summary && message.stopReason === "aborted") return;
    const id = randomUUID();
    Object.assign(message, { mateObservationId: id });
    this.pending.push({ id, message, reported, confirmed, request });
  }

  async writes(
    storage: Storage,
    writes: readonly StorageWrite[],
    context: Parameters<Storage["commit"]>[1],
  ) {
    const committedIds: string[] = [];
    const prepared = (enriched: readonly StorageWrite[]) => ({
      writes: enriched,
      committed: () => {
        for (const id of committedIds) {
          const index = this.pending.findIndex((item) => item.id === id);
          if (index >= 0) this.pending.splice(index, 1);
        }
      },
    });
    const enriched = writes.map((write) => {
      if (write.type !== "entry" || write.value.kind !== "pi.assistant") return write;
      const message = write.value.model?.[0];
      if (message?.role !== "assistant") return write;
      const marker = z.object({ mateObservationId: z.string() }).safeParse(message);
      const observation = marker.success
        ? this.pending.find(
            (item) => !item.request.summary && item.id === marker.data.mateObservationId,
          )
        : undefined;
      if (observation) committedIds.push(observation.id);
      const cleaned = { ...message };
      Reflect.deleteProperty(cleaned, "mateObservationId");
      return {
        ...write,
        value: {
          ...write.value,
          model: [cleaned],
          data: copyJson(
            {
              mateUsage: observation
                ? { confirmed: observation.confirmed, reported: observation.reported }
                : { confirmed: false, reported: null },
              mateRequest: observation
                ? { thinkingLevel: observation.request.thinkingLevel }
                : null,
            },
            { omitUndefinedProperties: true },
          ),
        },
      };
    });
    const compaction = writes.find(
      (write) => write.type === "task" && write.value.kind === "pi.compaction",
    );
    if (compaction?.type !== "task") return prepared(enriched);
    const scope = {
      kind: "conversation" as const,
      conversationId: compaction.value.conversationId,
    };
    // Adding an all-zero response leaves pi.usage unchanged. The native summary outcome
    // still commits availability; abort/fault outcomes do not commit a provider response.
    const state = compaction.value.state;
    if (
      state.status === "terminal"
        ? !["completed", "failed"].includes(state.outcome.status)
        : !z.object({ phase: z.literal("retry") }).safeParse(state.checkpoint).success
    )
      return prepared(enriched);
    const provider = await storage.findDocument({ kind: "pi.provider", scope }, "current", context);
    const identity = provider && (await storage.document(provider.id, "current", context));
    const sessionId =
      identity && z.object({ sessionId: z.string() }).parse(identity.value).sessionId;
    const index = this.pending.findIndex(
      (item) => item.request.summary && item.request.providerSessionId === sessionId,
    );
    if (index < 0) return prepared(enriched);
    const observation = this.pending[index]!;
    committedIds.push(observation.id);
    const address = { kind: summaryAvailabilityKind, scope };
    const record = await storage.findDocument(address, "current", context);
    const saved = record && (await storage.document(record.id, "current", context));
    const availability = saved ? summaryAvailabilitySchema.parse(saved.value) : { groups: {} };
    const key = `${observation.message.provider}/${observation.message.model}`;
    const group = availability.groups[key] ?? emptyCoverage();
    availability.groups[key] = group;
    const measured = tokensOf(observation.confirmed ? observation.reported : null);
    const normalized = nativeTokens(observation.message.usage);
    if (observation.confirmed) group.requestCount++;
    for (const name of tokenNames) {
      const value = measured[name];
      if (value !== null) group.known[name]++;
      // A missing field with nonzero normalized spend, or a contradictory breakdown,
      // cannot be subtracted as zero to infer a reliable summary aggregate.
      if (
        (value === null && normalized[name] !== 0) ||
        (value !== null && value !== normalized[name])
      )
        group.unsafe[name] = true;
    }
    if (
      measured.allInput !== null &&
      measured.allInput > 0 &&
      measured.cacheRead !== null &&
      measured.cacheRead <= measured.allInput
    ) {
      group.hitKnown++;
      group.hitInput += measured.allInput;
      group.hitRead += measured.cacheRead;
    }
    const content = { kind: "base" as const, version: 1, value: availability };
    if (record) enriched.push({ type: "document.change", id: record.id, content });
    else
      enriched.push({
        type: "document.create",
        record: {
          ...address,
          id: await storage.mintId<DocumentId>(),
          history: "latest",
          fork: "initial",
        },
        content,
      });
    return prepared(enriched);
  }
}
