// Build first: pnpm build:control-plane
// Run: node apps/control-plane/benchmarks/tool-action.mjs > result.json
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { cpus, platform, release, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import { AgentSession, agentSessionSchema } from "../dist/agent-session.js";
import { durableToolIdentity } from "../dist/agent-tool-identity.js";

const warmups = 10;
const iterations = 50;
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const agentId = uuid(1);
const nodeId = uuid(2);
const text = "固定合成历史，记录不是当前指令。".repeat(32);
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const results = [];
const directory = mkdtempSync(join(tmpdir(), "mate-tool-action-benchmark-"));
try {
  for (const count of [100, 1000, 10000]) {
    for (const layout of ["many-scopes", "single-scope"]) {
      const db = new Database(join(directory, `${count}-${layout}.sqlite`));
      try {
        db.pragma("journal_mode = WAL");
        db.pragma("foreign_keys = ON");
        db.exec(`CREATE TABLE owner_agents(id TEXT PRIMARY KEY);
          CREATE TABLE owner_agent_runs(id TEXT PRIMARY KEY, node_id TEXT, agent_id TEXT,
            delivery_id TEXT, state TEXT);
          ${agentSessionSchema}`);
        db.prepare("INSERT INTO owner_agents VALUES(?)").run(agentId);
        const session = new AgentSession(db);
        const scopeAt = (i) => uuid(100 + (layout === "single-scope" ? 0 : Math.floor(i / 100)));
        const runAt = (i) => uuid(1000 + (layout === "single-scope" ? 0 : Math.floor(i / 100)));
        const entryAt = (i) => uuid(10000 + i);
        const callAt = (i) => ({
          type: "toolCall",
          id: "reused-provider-call-id",
          name: "process.exec",
          arguments: { command: `printf 'synthetic-${i}'`, cwd: "." },
        });
        // Fixture creation, writes and identity construction are outside every timed section.
        db.transaction(() => {
          for (let i = 0; i < count; i++) {
            if (i === 0 || (layout === "many-scopes" && i % 100 === 0)) {
              db.prepare("INSERT INTO owner_agent_runs VALUES(?,?,?,?,'running')").run(
                runAt(i),
                nodeId,
                agentId,
                scopeAt(i),
              );
            }
            let message;
            if (i % 4 === 0) message = { role: "user", content: text, timestamp: i };
            else if (i % 4 === 2)
              message = {
                role: "toolResult",
                toolCallId: "reused-provider-call-id",
                toolName: "process.exec",
                content: [{ type: "text", text }],
                isError: false,
                timestamp: i,
              };
            else
              message = {
                role: "assistant",
                content: [{ type: "text", text }, ...(i % 4 === 1 ? [callAt(i)] : [])],
                timestamp: i,
                api: "openai-completions",
                provider: "openai",
                model: "synthetic",
                usage,
                stopReason: i % 4 === 1 ? "toolUse" : "stop",
              };
            assert.equal(
              session.append(runAt(i), nodeId, agentId, {
                kind: "message",
                id: entryAt(i),
                message,
              }),
              true,
            );
          }
        })();
        for (const position of ["early", "late", "missing", "missing-scope"]) {
          const target = position === "early" ? 1 : count - 3;
          const identity =
            position === "missing"
              ? `mate:${scopeAt(target)}:${"0".repeat(64)}:1`
              : position === "missing-scope"
                ? `mate:${uuid(999999)}:${"0".repeat(64)}:1`
                : durableToolIdentity(scopeAt(target), entryAt(target), callAt(target).id);
          const expected = position.startsWith("missing")
            ? undefined
            : {
                actionScopeId: scopeAt(target),
                name: "process.exec",
                input: callAt(target).arguments,
              };
          for (let i = 0; i < warmups; i++)
            assert.deepEqual(session.toolAction(agentId, identity), expected);
          const samplesMs = [];
          for (let i = 0; i < iterations; i++) {
            const start = performance.now();
            const result = session.toolAction(agentId, identity);
            samplesMs.push(performance.now() - start);
            assert.deepEqual(result, expected);
          }
          // A separate untimed pass counts JSON.parse inputs without distorting latency.
          let parsedRecords = 0,
            parsedBytes = 0;
          const parse = JSON.parse;
          try {
            JSON.parse = (value, ...args) => {
              parsedRecords++;
              parsedBytes += Buffer.byteLength(value, "utf8");
              return parse(value, ...args);
            };
            assert.deepEqual(session.toolAction(agentId, identity), expected);
          } finally {
            JSON.parse = parse;
          }
          const sorted = [...samplesMs].sort((a, b) => a - b);
          const percentile = (p) => sorted[Math.ceil(p * sorted.length) - 1];
          results.push({
            count,
            layout,
            position,
            parsedRecords,
            parsedBytes,
            minMs: sorted[0],
            medianMs: percentile(0.5),
            p95Ms: percentile(0.95),
            maxMs: sorted.at(-1),
            samplesMs,
          });
        }
      } finally {
        db.close();
      }
    }
  }
  process.stdout.write(
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        environment: {
          node: process.version,
          platform: platform(),
          release: release(),
          arch: process.arch,
          cpu: cpus()[0]?.model,
          sqlite: new Database(":memory:").prepare("SELECT sqlite_version() AS version").get()
            .version,
        },
        commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        sourceSha256: createHash("sha256")
          .update(readFileSync(new URL("../src/agent-session.ts", import.meta.url)))
          .digest("hex"),
        method: {
          warmups,
          iterations,
          statistics:
            "nearest-rank percentiles; full synchronous toolAction call; assertions outside timing",
          fixture:
            "file-backed SQLite WAL; 100 records per scope or one scope; four-message cycle: user, assistant tool call, toolResult, assistant text; identical provider call ID reused; deterministic UUIDs and text",
          excluded:
            "database construction, append writes, identity generation; JSON.parse instrumentation uses a separate untimed call",
          caveat: "warm local synthetic benchmark, not VPS or provider/model performance",
        },
        results,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
