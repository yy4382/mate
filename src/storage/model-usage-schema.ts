import type { Store } from "./store.js";
import { modelUsageSchema } from "./schema.js";

interface HistoricalRun {
  id: string;
  agent_id: string;
}
interface HistoricalEntry {
  seq: number;
  message: string;
}

/** Preserve only usage evidenced by a durable model response. Old reservations are not usage. */
export function migrateModelUsage(store: Store): void {
  const version = Number(store.db.pragma("user_version", { simple: true }));
  if (version === 25) return;
  if (version !== 24) throw new Error("Model usage migration requires current runtime schema");
  store.atomic(() => {
    store.db.exec(modelUsageSchema);
    const runs = store.db.prepare("SELECT id,agent_id FROM runs").all() as HistoricalRun[];
    const entries = store.db.prepare(
      "SELECT seq,message FROM entries WHERE key LIKE ? ORDER BY seq",
    );
    const insert = store.db.prepare(`INSERT INTO model_usage
      (run_id,call_index,agent_id,work_id,provider,model_id,state,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,estimated_cost_usd,source)
      VALUES(?,?,?,?,?,?,'known',?,?,?,?,?,?,'journal_backfill')`);
    for (const run of runs)
      for (const entry of entries.all(`${run.id}:message:%`) as HistoricalEntry[]) {
        let message: any;
        try {
          message = JSON.parse(entry.message);
        } catch {
          continue;
        }
        if (message?.role !== "assistant" || ["error", "aborted"].includes(message.stopReason))
          continue;
        const usage = message.usage,
          cost = usage?.cost?.total;
        const values = [
          usage?.input,
          usage?.output,
          usage?.cacheRead,
          usage?.cacheWrite,
          usage?.totalTokens,
          cost,
        ];
        if (values.some((value) => !Number.isFinite(value) || value < 0)) continue;
        // v24 did not capture work selection at each provider call. Leave historical
        // work attribution unknown rather than assigning every call to the first work.
        insert.run(
          run.id,
          entry.seq,
          run.agent_id,
          null,
          String(message.provider ?? "unknown"),
          String(message.model ?? "unknown"),
          ...values,
        );
      }
    // Reservations were worst-case allowances, never evidence of model use.
    // Keep the run/work identity and lifecycle, then remove obsolete quota state.
    store.db.exec(`
      DROP TABLE budget_runs;
      DROP TABLE budget_accounts;
      ALTER TABLE work_runs DROP COLUMN token_cap;
      ALTER TABLE work_runs DROP COLUMN cost_cap;
      ALTER TABLE work_runs DROP COLUMN settled;
      ALTER TABLE works DROP COLUMN max_runs;
      ALTER TABLE works DROP COLUMN max_tokens;
      ALTER TABLE works DROP COLUMN max_cost;
      ALTER TABLE works DROP COLUMN runs;
      ALTER TABLE works DROP COLUMN tokens;
      ALTER TABLE works DROP COLUMN cost;
    `);
  });
}
