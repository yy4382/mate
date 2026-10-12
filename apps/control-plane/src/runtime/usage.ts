import { z } from "zod";
import { type ReportedUsage } from "./provider-response.js";
import { usageObservationSchema } from "./usage-observation.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Storage, ConversationId } from "@earendil-works/pi-durable";
import type Database from "better-sqlite3";

import {
  tokenNames,
  zeroTokenCounts,
  tokensOf,
  nativeTokens,
  summaryAvailabilitySchema,
  summaryAvailabilityKind,
  nativeUsageSchema,
  type SummaryCoverage,
} from "./usage-observation.js";
const usageProjectionSchema = z.object({ mateUsage: usageObservationSchema });
const nativeModelUsageSchema = z.object({ models: z.record(z.string(), nativeUsageSchema) });
class UsageAccumulator {
  private requestCount = 0;
  private readonly totals = zeroTokenCounts();
  private readonly known = zeroTokenCounts();
  private hitInput = 0;
  private hitRead = 0;
  private hitKnown = 0;

  add(reported: ReportedUsage | null): void {
    this.requestCount++;
    const measured = tokensOf(reported);
    for (const name of tokenNames) {
      const value = measured[name];
      if (value === null) continue;
      this.totals[name] += value;
      this.known[name]++;
    }
    if (
      measured.allInput !== null &&
      measured.allInput > 0 &&
      measured.cacheRead !== null &&
      measured.cacheRead <= measured.allInput
    ) {
      this.hitInput += measured.allInput;
      this.hitRead += measured.cacheRead;
      this.hitKnown++;
    }
  }

  addSummary(
    coverage: SummaryCoverage,
    remainder: ReturnType<typeof nativeTokens> | undefined,
  ): void {
    this.requestCount += coverage.requestCount;
    for (const name of tokenNames) {
      const value = remainder?.[name];
      if (coverage.unsafe[name] || value === undefined || value < 0 || !coverage.known[name])
        continue;
      this.totals[name] += value;
      this.known[name] += coverage.known[name];
    }
    this.hitKnown += coverage.hitKnown;
    this.hitInput += coverage.hitInput;
    this.hitRead += coverage.hitRead;
  }

  snapshot() {
    const metric = (name: keyof ReturnType<typeof zeroTokenCounts>) => ({
      value: this.known[name] ? this.totals[name] : null,
      knownRequests: this.known[name],
      missingRequests: this.requestCount - this.known[name],
    });
    const tokens = {
      uncachedInput: metric("uncachedInput"),
      cacheRead: metric("cacheRead"),
      cacheWrite: metric("cacheWrite"),
      allInput: metric("allInput"),
      output: metric("output"),
      total: metric("total"),
      reasoningOutput: metric("reasoningOutput"),
    };
    return {
      requestCount: this.requestCount,
      tokens,
      cacheHitRate: {
        value: this.hitKnown ? this.hitRead / this.hitInput : null,
        knownRequests: this.hitKnown,
        missingRequests: this.requestCount - this.hitKnown,
      },
    };
  }
}

function responseFor(
  agentId: string,
  total: UsageAccumulator,
  normal: UsageAccumulator,
  summary: UsageAccumulator,
  latestNormal: { id: string; recordedAt: number; reported: ReportedUsage | null } | null,
) {
  const latest = new UsageAccumulator();
  if (latestNormal) latest.add(latestNormal.reported);
  return {
    agentId,
    total: total.snapshot(),
    normal: normal.snapshot(),
    summary: summary.snapshot(),
    latestNormal: latestNormal
      ? { id: latestNormal.id, recordedAt: latestNormal.recordedAt, ...latest.snapshot() }
      : null,
  };
}

async function usageState(storage: Storage, conversationId: ConversationId) {
  const scope = { kind: "conversation" as const, conversationId };
  const read = async (kind: string) => {
    const record = await storage.findDocument({ kind, scope }, "current", BACKGROUND_CONTEXT);
    return record && (await storage.document(record.id, "current", BACKGROUND_CONTEXT));
  };
  const native = await read("pi.usage");
  const availability = await read(summaryAvailabilityKind);
  return {
    models: native ? nativeModelUsageSchema.parse(native.value).models : {},
    groups: availability ? summaryAvailabilitySchema.parse(availability.value).groups : {},
  };
}

async function projectUsage(storage: Storage, agentId: string) {
  const conversations = await storage.scanConversations({}, 2, undefined, BACKGROUND_CONTEXT);
  if (conversations.items.length !== 1) throw new Error("Agent usage unavailable");
  const conversationId = conversations.items[0]!.id;
  for (;;) {
    const state = await usageState(storage, conversationId);
    const through = (
      await storage.scanEntries({ conversationId }, 1, undefined, BACKGROUND_CONTEXT)
    ).items[0]?.id;
    const total = new UsageAccumulator();
    const normal = new UsageAccumulator();
    const summary = new UsageAccumulator();
    let latestNormal: { id: string; recordedAt: number; reported: ReportedUsage | null } | null =
      null;
    const ordinary: Record<string, ReturnType<typeof nativeTokens>> = {};
    if (through !== undefined) {
      let cursor;
      do {
        const page = await storage.scanEntries(
          { conversationId, order: "ascending", maxEntryId: through },
          100,
          cursor,
          BACKGROUND_CONTEXT,
        );
        for (const entry of page.items) {
          if (entry.kind !== "pi.assistant") continue;
          const message = entry.model?.[0];
          if (message?.role !== "assistant") continue;
          const key = `${message.provider}/${message.model}`;
          const grouped = ordinary[key] ?? zeroTokenCounts();
          ordinary[key] = grouped;
          const normalized = nativeTokens(message.usage);
          for (const name of tokenNames) grouped[name] += normalized[name];
          const parsed = usageProjectionSchema.safeParse(entry.data);
          const observed = parsed.success && parsed.data.mateUsage.confirmed;
          // Durable converts saved progress into an aborted ordinary response and
          // records its normalized spend. A crash lost the provider availability,
          // so count this committed attempt while keeping every field unknown.
          if (!observed && message.stopReason !== "aborted") continue;
          const reported = observed ? parsed.data.mateUsage.reported : null;
          total.add(reported);
          normal.add(reported);
          latestNormal = { id: `${agentId}:${entry.id}`, recordedAt: message.timestamp, reported };
        }
        cursor = page.next;
      } while (cursor);
    }
    // The public adapter materializes each document atomically, rather than nesting a
    // second SQL transaction. Retry a concurrent model commit so subtraction and
    // coverage refer to one committed range. The fixed entry tail never grows mid-scan.
    if (JSON.stringify(state) !== JSON.stringify(await usageState(storage, conversationId)))
      continue;
    for (const [key, coverage] of Object.entries(state.groups)) {
      const native = state.models[key];
      const remainder = native && nativeTokens(native);
      if (remainder) for (const name of tokenNames) remainder[name] -= ordinary[key]?.[name] ?? 0;
      summary.addSummary(coverage, remainder);
      total.addSummary(coverage, remainder);
    }
    return responseFor(agentId, total, normal, summary, latestNormal);
  }
}

/** Native model totals and all ordinary responses share a stable committed scope; tool spend is separate. */
export async function agentUsage(db: Database.Database, agentId: string) {
  const path = join(dirname(db.name), "durable", `${agentId}.sqlite`);
  if (!existsSync(path))
    return responseFor(
      agentId,
      new UsageAccumulator(),
      new UsageAccumulator(),
      new UsageAccumulator(),
      null,
    );
  const database = await openNodeSqliteDatabase(path);
  let storage;
  try {
    await database.exec("PRAGMA synchronous=FULL;");
    storage = await SqliteStorage.open(database);
    return await projectUsage(storage, agentId);
  } finally {
    if (storage) await storage.close(BACKGROUND_CONTEXT);
    else await database.close();
  }
}
