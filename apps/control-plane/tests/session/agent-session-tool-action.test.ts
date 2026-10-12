import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { AgentSession } from "../../src/runtime/session/service.js";
import { agentSessionSchema } from "../../src/runtime/session/schema.js";

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
    const runId = randomUUID();
    const actionScopeId = randomUUID();
    db.prepare("INSERT OR IGNORE INTO owner_agents VALUES(?)").run(agentId);
    db.prepare("INSERT INTO owner_agent_runs VALUES(?,?,?,?,'running')").run(
      runId,
      nodeId,
      agentId,
      actionScopeId,
    );
    return { runId, agentId, actionScopeId };
  }
  function call(
    current: ReturnType<typeof run>,
    name: string,
    input: Record<string, unknown>,
    taskId: string = randomUUID(),
  ) {
    return {
      taskId,
      identity: session.bindTool(
        current.agentId,
        current.agentId,
        current.actionScopeId,
        taskId,
        name,
        input,
      ),
    };
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

it("binds independent native tool tasks to their Agent and original scope without provider IDs", () => {
  const f = fixture();
  try {
    const first = f.run();
    const other = f.run();
    const next = f.run(first.agentId);
    const early = f.call(first, "process.exec", { command: "printf first", cwd: "." });
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

it("reopening reuses the same native task effect identity and rejects changed tool or arguments", () => {
  const f = fixture();
  try {
    const original = f.run();
    const input = { name: "workspace.write", input: { path: "原始.txt", content: "once" } };
    const call = f.call(original, "tools.call", input, "42");
    f.reopen();
    const resumed = f.run(original.agentId);
    expect(f.call(resumed, "tools.call", input, "42").identity).toBe(call.identity);
    expect(f.session.toolAction(resumed.agentId, call.identity)).toEqual({
      actionScopeId: original.actionScopeId,
      name: "tools.call",
      input,
    });
    expect(() => f.call(resumed, "tools.describe", input, "42")).toThrow("binding differs");
    expect(() =>
      f.call(resumed, "tools.call", { ...input, input: { path: "different" } }, "42"),
    ).toThrow("binding differs");
    const peer = f.run();
    expect(f.call(peer, "tools.call", input, "42").identity).not.toBe(call.identity);
    expect(f.session.toolAction(peer.agentId, call.identity)).toBeUndefined();
  } finally {
    f.close();
  }
});
