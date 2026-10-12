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
import { AgentSession } from "../dist/runtime/session/service.js";
import { agentSessionSchema } from "../dist/runtime/session/schema.js";
import { durableToolIdentity } from "../dist/runtime/tools/identity.js";

const warmups = 10;
const iterations = 50;
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const agentId = uuid(1);
const nodeId = uuid(2);
const sessionId = uuid(3);

const results = [];
let sqliteVersion;
const directory = mkdtempSync(join(tmpdir(), "mate-tool-action-benchmark-"));
try {
  for (const count of [100, 1000, 10000]) {
    for (const layout of ["many-scopes", "single-scope"]) {
      const db = new Database(join(directory, `${count}-${layout}.sqlite`));
      try {
        sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get().version;
        db.pragma("journal_mode = WAL");
        db.pragma("foreign_keys = ON");
        db.exec(`CREATE TABLE owner_agents(id TEXT PRIMARY KEY);
          CREATE TABLE owner_message_deliveries(id TEXT PRIMARY KEY);
          CREATE TABLE owner_agent_runs(id TEXT PRIMARY KEY, node_id TEXT, agent_id TEXT,
            delivery_id TEXT, state TEXT);
          ${agentSessionSchema}`);
        db.prepare("INSERT INTO owner_agents VALUES(?)").run(agentId);
        const session = new AgentSession(db);
        const scopeAt = (i) => uuid(100 + (layout === "single-scope" ? 0 : Math.floor(i / 100)));
        const runAt = (i) => uuid(1000 + (layout === "single-scope" ? 0 : Math.floor(i / 100)));
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
            session.bindTool(
              agentId,
              sessionId,
              scopeAt(i),
              String(i),
              "process.exec",
              callAt(i).arguments,
            );
          }
        })();
        function actionIdentity(position, target) {
          if (position === "missing") return `mate:${scopeAt(target)}:${"0".repeat(64)}:1`;
          if (position === "missing-scope") return `mate:${uuid(999999)}:${"0".repeat(64)}:1`;
          return durableToolIdentity(scopeAt(target), sessionId, String(target));
        }

        for (const position of ["early", "late", "missing", "missing-scope"]) {
          const target = position === "early" ? 1 : count - 3;
          const identity = actionIdentity(position, target);
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
          let parsedRecords = 0;
          let parsedBytes = 0;
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
          sqlite: sqliteVersion,
        },
        commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        sourceSha256: createHash("sha256")
          .update(readFileSync(new URL("../src/runtime/session/service.ts", import.meta.url)))
          .digest("hex"),
        method: {
          warmups,
          iterations,
          statistics:
            "nearest-rank percentiles; full synchronous toolAction call; assertions outside timing",
          fixture:
            "file-backed SQLite WAL; 100 records per scope or one scope; native tool-task bindings; deterministic scope/task identities and inputs",
          excluded:
            "database construction, binding writes, identity generation; JSON.parse instrumentation uses a separate untimed call",
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
