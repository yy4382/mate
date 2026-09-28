import type Database from "better-sqlite3";
import type { ReportedUsage } from "../nodes/session-compaction.js";

type Metric = { value: number | null; knownRequests: number; missingRequests: number };
type TokenName =
  | "uncachedInput"
  | "cacheRead"
  | "cacheWrite"
  | "allInput"
  | "output"
  | "total"
  | "reasoningOutput";
type Sample = {
  id: string;
  recordedAt: number;
  kind: "normal" | "summary";
  reported: ReportedUsage | null;
};

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
      allInput = reported.input;
      if (cacheRead !== null && cacheWrite !== null && cacheRead + cacheWrite <= reported.input)
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

function metric(values: Array<number | null>): Metric {
  const known = values.filter((value): value is number => value !== null);
  return {
    value: known.length ? known.reduce((sum, value) => sum + value, 0) : null,
    knownRequests: known.length,
    missingRequests: values.length - known.length,
  };
}

function summarize(samples: Sample[]) {
  const measured = samples.map((sample) => tokensOf(sample.reported));
  const names: TokenName[] = [
    "uncachedInput",
    "cacheRead",
    "cacheWrite",
    "allInput",
    "output",
    "total",
    "reasoningOutput",
  ];
  const tokens = Object.fromEntries(
    names.map((name) => [name, metric(measured.map((row) => row[name]))]),
  ) as Record<TokenName, Metric>;
  const complete = measured.filter(
    (row) =>
      row.allInput !== null &&
      row.allInput > 0 &&
      row.cacheRead !== null &&
      row.cacheRead <= row.allInput,
  );
  const denominator = complete.reduce((sum, row) => sum + row.allInput!, 0);
  const cacheHitRate: Metric = {
    value:
      complete.length && denominator > 0
        ? complete.reduce((sum, row) => sum + row.cacheRead!, 0) / denominator
        : null,
    knownRequests: complete.length,
    missingRequests: samples.length - complete.length,
  };
  return { requestCount: samples.length, tokens, cacheHitRate };
}

/** Each confirmed request appears once in the immutable per-Agent session log. */
export function agentUsage(db: Database.Database, agentId: string) {
  const rows = db
    .prepare(
      `SELECT id,kind,payload_json,created_at FROM owner_agent_session_records
     WHERE agent_id=? AND kind IN ('message','summary_usage') ORDER BY seq`,
    )
    .all(agentId) as Array<{ id: string; kind: string; payload_json: string; created_at: number }>;
  const samples: Sample[] = [];
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json);
    if (row.kind === "message" && payload.modelRequest !== true) continue;
    samples.push({
      id: row.id,
      recordedAt: row.created_at,
      kind: row.kind === "summary_usage" ? "summary" : "normal",
      reported: payload.reportedUsage ?? null,
    });
  }
  const normal = samples.filter((sample) => sample.kind === "normal");
  const summary = samples.filter((sample) => sample.kind === "summary");
  const latest = normal.at(-1);
  return {
    agentId,
    total: summarize(samples),
    normal: summarize(normal),
    summary: summarize(summary),
    latestNormal: latest
      ? { id: latest.id, recordedAt: latest.recordedAt, ...summarize([latest]) }
      : null,
  };
}
