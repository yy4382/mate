import type { AssistantMessage } from "@earendil-works/pi-ai";
import type Database from "better-sqlite3";
import type { RunToken, Store } from "../storage/store.js";

export interface UsageSummary {
  knownCalls: number;
  unknownCalls: number;
  backfilledCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

/** Provider-call evidence is recorded separately from the conversation journal. */
export class UsageLedger {
  constructor(readonly store: Store) {}

  begin(
    run: RunToken,
    workId: string | null,
    callIndex: number,
    provider: string,
    modelId: string,
  ): void {
    if (!Number.isSafeInteger(callIndex) || callIndex < 1 || !provider || !modelId)
      throw new Error("Invalid model usage call identity");
    this.store.atomic(() => {
      this.store.assertRun(run);
      this.store.db
        .prepare(
          `INSERT INTO model_usage
        (run_id,call_index,agent_id,work_id,provider,model_id,state,source)
        VALUES(?,?,?,?,?,?,'unknown','runtime')`,
        )
        .run(run.id, callIndex, run.agentId, workId, provider, modelId);
    });
  }

  complete(run: RunToken, callIndex: number, message: AssistantMessage): boolean {
    const usage = message.usage;
    const counts = [
      usage?.input,
      usage?.output,
      usage?.cacheRead,
      usage?.cacheWrite,
      usage?.totalTokens,
    ];
    const cost = usage?.cost?.total;
    if (
      message.role !== "assistant" ||
      ["error", "aborted"].includes(message.stopReason) ||
      counts.some((value) => !Number.isSafeInteger(value) || value! < 0) ||
      !Number.isFinite(cost) ||
      cost! < 0
    )
      return false;
    this.store.atomic(() => {
      this.store.assertRun(run);
      const changed = this.store.db
        .prepare(
          `UPDATE model_usage SET state='known',
        input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_write_tokens=?,total_tokens=?,estimated_cost_usd=?
        WHERE run_id=? AND call_index=? AND agent_id=? AND provider=? AND model_id=? AND state='unknown' AND source='runtime'`,
        )
        .run(
          ...counts,
          cost,
          run.id,
          callIndex,
          run.agentId,
          message.provider,
          message.model,
        ).changes;
      if (changed !== 1) throw new Error("Model usage call not awaiting completion");
    });
    return true;
  }

  summary(agentId: string, workId?: string): UsageSummary {
    return UsageLedger.summaryFrom(this.store.db, agentId, workId);
  }

  static summaryFrom(db: Database.Database, agentId: string, workId?: string): UsageSummary {
    const predicate = workId === undefined ? "agent_id=?" : "agent_id=? AND work_id=?";
    const row = db
      .prepare(
        `SELECT
      SUM(CASE WHEN state='known' THEN 1 ELSE 0 END) knownCalls,
      SUM(CASE WHEN state='unknown' THEN 1 ELSE 0 END) unknownCalls,
      SUM(CASE WHEN source='journal_backfill' THEN 1 ELSE 0 END) backfilledCalls,
      SUM(COALESCE(input_tokens,0)) inputTokens,
      SUM(COALESCE(output_tokens,0)) outputTokens,
      SUM(COALESCE(cache_read_tokens,0)) cacheReadTokens,
      SUM(COALESCE(cache_write_tokens,0)) cacheWriteTokens,
      SUM(COALESCE(total_tokens,0)) totalTokens,
      SUM(COALESCE(estimated_cost_usd,0)) estimatedCostUsd
      FROM model_usage WHERE ${predicate}`,
      )
      .get(...(workId === undefined ? [agentId] : [agentId, workId])) as Record<
      keyof UsageSummary,
      number | null
    >;
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, value ?? 0]),
    ) as unknown as UsageSummary;
  }

  readAgent(agentId: string): UsageSummary {
    return this.summary(agentId);
  }
}
