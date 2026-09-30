import type Database from "better-sqlite3";
import type { ReportedUsage } from "@mate/protocol";

type Metric = { value: number | null; knownRequests: number; missingRequests: number };
type TokenName =
  | "uncachedInput"
  | "cacheRead"
  | "cacheWrite"
  | "allInput"
  | "output"
  | "total"
  | "reasoningOutput";
const tokenNames: TokenName[] = [
  "uncachedInput",
  "cacheRead",
  "cacheWrite",
  "allInput",
  "output",
  "total",
  "reasoningOutput",
];

function tokensOf(reported: ReportedUsage | null): Record<TokenName, number | null> {
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

class UsageAccumulator {
  private requestCount = 0;
  private readonly totals = Object.fromEntries(tokenNames.map((name) => [name, 0])) as Record<
    TokenName,
    number
  >;
  private readonly known = Object.fromEntries(tokenNames.map((name) => [name, 0])) as Record<
    TokenName,
    number
  >;
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

  snapshot() {
    const tokens = Object.fromEntries(
      tokenNames.map((name) => [
        name,
        {
          value: this.known[name] ? this.totals[name] : null,
          knownRequests: this.known[name],
          missingRequests: this.requestCount - this.known[name],
        },
      ]),
    ) as Record<TokenName, Metric>;
    return {
      requestCount: this.requestCount,
      tokens,
      cacheHitRate: {
        value: this.hitKnown ? this.hitRead / this.hitInput : null,
        knownRequests: this.hitKnown,
        missingRequests: this.requestCount - this.hitKnown,
      } satisfies Metric,
    };
  }
}

/** Each confirmed request appears once in the immutable per-Agent session log. */
export function agentUsage(db: Database.Database, agentId: string) {
  const total = new UsageAccumulator();
  const normal = new UsageAccumulator();
  const summary = new UsageAccumulator();
  let latestNormal: { id: string; recordedAt: number; reported: ReportedUsage | null } | null =
    null;
  const rows = db
    .prepare(
      `SELECT id,kind,usage_json,created_at FROM owner_agent_session_records
     WHERE agent_id=? AND usage_json IS NOT NULL ORDER BY seq`,
    )
    .iterate(agentId) as IterableIterator<{
    id: string;
    kind: string;
    usage_json: string;
    created_at: number;
  }>;
  for (const row of rows) {
    const reported = (JSON.parse(row.usage_json) as { reportedUsage: ReportedUsage | null })
      .reportedUsage;
    total.add(reported);
    if (row.kind === "summary_usage") summary.add(reported);
    else {
      normal.add(reported);
      latestNormal = { id: row.id, recordedAt: row.created_at, reported };
    }
  }
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
