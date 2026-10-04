import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { ToolCall } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { AgentSession } from "../../src/runtime/session/service.js";
import { agentSessionSchema } from "../../src/runtime/session/schema.js";
import { durableToolIdentity } from "../../src/runtime/tools/identity.js";
import { assistantMessage } from "../support/agent/session.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mate-tool-action-"));
  const path = join(directory, "session.sqlite");
  let db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE owner_agents(id TEXT PRIMARY KEY);
    CREATE TABLE owner_agent_runs(id TEXT PRIMARY KEY, node_id TEXT, agent_id TEXT,
      delivery_id TEXT, state TEXT);
    ${agentSessionSchema}`);
  const nodeId = randomUUID();
  let session = new AgentSession(db);
  function run(agentId = randomUUID()) {
    const runId = randomUUID(),
      actionScopeId = randomUUID();
    db.prepare("INSERT OR IGNORE INTO owner_agents VALUES(?)").run(agentId);
    db.prepare("INSERT INTO owner_agent_runs VALUES(?,?,?,?,'running')").run(
      runId,
      nodeId,
      agentId,
      actionScopeId,
    );
    return { runId, agentId, actionScopeId };
  }
  function call(current: ReturnType<typeof run>, name: string, input: ToolCall["arguments"]) {
    const id = randomUUID();
    // Providers can repeat their own IDs, even in the same delivery scope.
    const toolCallId = "provider-repeated-id";
    expect(
      session.append(current.runId, nodeId, current.agentId, {
        kind: "message",
        id,
        message: {
          ...assistantMessage("原始 assistant 文本"),
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: toolCallId, name, arguments: input }],
        },
      }),
    ).toBe(true);
    return { id, identity: durableToolIdentity(current.actionScopeId, id, toolCallId) };
  }
  return {
    nodeId,
    run,
    call,
    get session() {
      return session;
    },
    reopen() {
      db.close();
      db = new Database(path);
      db.pragma("foreign_keys = ON");
      session = new AgentSession(db);
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it("finds early and late committed calls without confusing repeated provider IDs, Agents or scopes", () => {
  const f = fixture();
  try {
    const first = f.run(),
      other = f.run(),
      next = f.run(first.agentId);
    const early = f.call(first, "process.exec", { command: "printf first", cwd: "." });
    for (let i = 0; i < 120; i++) {
      expect(
        f.session.append(first.runId, f.nodeId, first.agentId, {
          kind: "message",
          id: randomUUID(),
          message: { role: "user", content: `合成观察 ${i}`, timestamp: i },
        }),
      ).toBe(true);
    }
    const sameScope = f.call(first, "tools.call", {
      name: "workspace.write",
      input: { path: "note.txt", content: "第二次" },
    });
    const foreign = f.call(other, "process.exec", { command: "printf foreign" });
    const late = f.call(next, "process.stop", { targetOperationId: "original-operation" });
    expect(
      new Set([early.identity, sameScope.identity, foreign.identity, late.identity]).size,
    ).toBe(4);
    expect(f.session.toolAction(first.agentId, early.identity)).toEqual({
      actionScopeId: first.actionScopeId,
      name: "process.exec",
      input: { command: "printf first", cwd: "." },
    });
    expect(f.session.toolAction(first.agentId, sameScope.identity)).toEqual({
      actionScopeId: first.actionScopeId,
      name: "tools.call",
      input: { name: "workspace.write", input: { path: "note.txt", content: "第二次" } },
    });
    expect(f.session.toolAction(first.agentId, late.identity)).toEqual({
      actionScopeId: next.actionScopeId,
      name: "process.stop",
      input: { targetOperationId: "original-operation" },
    });
    expect(f.session.toolAction(other.agentId, early.identity)).toBeUndefined();
    expect(f.session.toolAction(first.agentId, foreign.identity)).toBeUndefined();
    expect(
      f.session.toolAction(
        first.agentId,
        early.identity.replace(first.actionScopeId, next.actionScopeId),
      ),
    ).toBeUndefined();
    expect(
      f.session.toolAction(first.agentId, `mate:${first.actionScopeId}:${"0".repeat(64)}:1`),
    ).toBeUndefined();
    expect(
      f.session.toolAction(
        first.agentId,
        early.identity.replace(first.actionScopeId, randomUUID()),
      ),
    ).toBeUndefined();
    for (const malformed of [
      "",
      "provider-repeated-id",
      early.identity + ":extra",
      early.identity + "\n",
      early.identity.slice(0, -1) + "2",
      early.identity.replace("mate:", "MATE:"),
      `mate:${first.actionScopeId}:abc:1`,
      `mate:${first.actionScopeId}:${"g".repeat(64)}:1`,
      `mate:not-a-scope:${"0".repeat(64)}:1`,
    ]) {
      expect(f.session.toolAction(first.agentId, malformed)).toBeUndefined();
    }
  } finally {
    f.close();
  }
});

it("recovers original names and arguments before compaction after reopening the database", () => {
  const f = fixture();
  try {
    const originalRun = f.run();
    const old = f.call(originalRun, "tools.call", {
      name: "workspace.write",
      input: { path: "原始.txt", content: "only once", append: false },
    });
    const kept = f.call(originalRun, "process.exec", { command: "printf retained", cwd: "." });
    const through = randomUUID();
    expect(
      f.session.append(originalRun.runId, f.nodeId, originalRun.agentId, {
        kind: "message",
        id: through,
        message: {
          role: "toolResult",
          toolCallId: "provider-repeated-id",
          toolName: "process.exec",
          isError: false,
          content: [{ type: "text", text: "retained" }],
          timestamp: 2,
        },
      }),
    ).toBe(true);
    expect(
      f.session.append(originalRun.runId, f.nodeId, originalRun.agentId, {
        kind: "compaction",
        id: randomUUID(),
        firstKeptEntryId: kept.id,
        throughEntryId: through,
        summary: "摘要没有保留旧工具参数",
        tokensBefore: 100,
        summaryRequestIds: [randomUUID()],
      }),
    ).toBe(true);
    expect(f.session.context(originalRun.agentId).map((entry) => entry.id)).toEqual([
      kept.id,
      through,
    ]);
    f.reopen();
    const resumed = f.run(originalRun.agentId);
    f.call(resumed, "tools.call", {
      name: "workspace.write",
      input: { path: "different.txt", content: "changed" },
    });
    expect(f.session.toolAction(resumed.agentId, old.identity)).toEqual({
      actionScopeId: originalRun.actionScopeId,
      name: "tools.call",
      input: {
        name: "workspace.write",
        input: { path: "原始.txt", content: "only once", append: false },
      },
    });
    expect(f.session.toolAction(resumed.agentId, kept.identity)).toEqual({
      actionScopeId: originalRun.actionScopeId,
      name: "process.exec",
      input: { command: "printf retained", cwd: "." },
    });
    expect(f.session.context(resumed.agentId)).toHaveLength(3);
  } finally {
    f.close();
  }
});
