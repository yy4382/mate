import Database from "better-sqlite3";
import { AgentTools } from "../../src/runtime/tools/registry.js";
import { AgentProcessOperationBroker } from "../../src/runtime/process-operations.js";
import { answer } from "../helpers/pi.js";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { AgentSession } from "../../src/runtime/session/service.js";
import type { SessionCommit } from "../../src/runtime/session/record.js";
import { setup, authorizeModel, addAgent, waitForRuns } from "../helpers/agent-tool-fixture.js";

async function historyFixture() {
  const fixture = await setup();
  const { app, cookie, nodeId, socket, db } = fixture;
  const agentId = addAgent(app, nodeId, "History reader");
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await authorizeModel(app, cookie);
  app.chat.createMessage(direct.id, "Read confirmed history.");
  const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
  const identity = { runId: run.runId, nodeId, agentId, toolCallId: "history-observation" };
  const session = new AgentSession(db);
  const append = (entry: SessionCommit) => {
    expect(session.append(run.runId, nodeId, agentId, entry)).toBe(true);
    return entry.id;
  };
  const message = (content: string) =>
    append({
      kind: "message",
      id: randomUUID(),
      message: { role: "user", content, timestamp: 1234 },
    });
  const call = (name: string, input: unknown) =>
    app.tools.execute(identity, "tools.call", { name, input });
  return { ...fixture, agentId, direct, run, identity, session, append, message, call };
}

it("discovers confirmed history and returns stable source metadata and literal text ranges", async () => {
  const { app, identity, run, agentId, message, call } = await historyFixture();
  const before = Date.now();
  const id = message("[私信] 中文.* 中文.*");
  const after = Date.now();
  expect(await app.tools.execute(identity, "tools.list", {})).toMatchObject({
    ok: true,
    result: {
      tools: expect.arrayContaining([
        { name: "history.search", description: expect.any(String) },
        { name: "history.read", description: expect.any(String) },
      ]),
    },
  });
  const result = await call("history.search", { query: "中文.*" });
  expect(result).toMatchObject({
    ok: true,
    result: {
      scanned: 1,
      nextCursor: null,
      hits: [
        {
          id,
          agentId,
          seq: expect.any(Number),
          runId: run.runId,
          actionScopeId: run.actionScopeId,
          role: "user",
          timestamp: 1234,
          confirmedAt: expect.any(Number),
          match: { start: 5, end: 9 },
          excerpt: { start: 0, end: 14, text: "[私信] 中文.* 中文.*" },
        },
      ],
    },
  });
  if (!result.ok) throw new Error(result.error);
  const hit = (result.result as { hits: Array<{ confirmedAt: number }> }).hits[0]!;
  expect(hit.confirmedAt).toBeGreaterThanOrEqual(before);
  expect(hit.confirmedAt).toBeLessThanOrEqual(after);
  expect(await call("history.read", { id })).toMatchObject({
    ok: true,
    result: {
      id,
      agentId,
      runId: run.runId,
      actionScopeId: run.actionScopeId,
      role: "user",
      timestamp: 1234,
      text: "[私信] 中文.* 中文.*",
      offset: 0,
      nextOffset: null,
      totalLength: 14,
      previousId: null,
      nextId: null,
    },
  });
});

it("continues through empty batches and hit limits in a fixed range while new records arrive", async () => {
  const { message, call } = await historyFixture();
  for (let index = 0; index < 100; index++) message("not a match");
  const ids = Array.from({ length: 25 }, () => message("needle needle"));
  const first = await call("history.search", { query: "needle" });
  expect(first).toMatchObject({
    ok: true,
    result: { hits: [], scanned: 100, nextCursor: expect.any(Object) },
  });
  if (!first.ok) throw new Error(first.error);
  const cursor = (first.result as { nextCursor: unknown }).nextCursor;
  const added = message("needle appended later");
  const second = await call("history.search", { query: "needle", cursor });
  expect(second).toMatchObject({
    ok: true,
    result: {
      scanned: 20,
      hits: ids.slice(0, 20).map((id) => ({ id, match: { start: 0, end: 6 } })),
      nextCursor: expect.any(Object),
    },
  });
  if (!second.ok) throw new Error(second.error);
  const third = await call("history.search", {
    query: "needle",
    cursor: (second.result as { nextCursor: unknown }).nextCursor,
  });
  expect(third).toMatchObject({
    ok: true,
    result: { scanned: 5, hits: ids.slice(20).map((id) => ({ id })), nextCursor: null },
  });
  const fresh = await call("history.search", { query: "appended later" });
  if (!fresh.ok) throw new Error(fresh.error);
  expect(
    await call("history.search", {
      query: "appended later",
      cursor: (fresh.result as { nextCursor: unknown }).nextCursor,
    }),
  ).toMatchObject({ ok: true, result: { hits: [{ id: added }], nextCursor: null } });
});

it("reads long messages without losing text and keeps every UTF-16 boundary outside surrogate pairs", async () => {
  const { message, call } = await historyFixture();
  const previousId = message("previous");
  const text = "x".repeat(7999) + "😀" + "y".repeat(8200);
  const id = message(text);
  const nextId = message("next");
  expect(await call("history.read", { id })).toMatchObject({
    ok: true,
    result: {
      text: "x".repeat(7999),
      offset: 0,
      nextOffset: 7999,
      totalLength: 16201,
      previousId,
      nextId,
    },
  });
  expect(await call("history.read", { id, offset: 7999, maxChars: 2 })).toMatchObject({
    ok: true,
    result: {
      text: "😀",
      offset: 7999,
      nextOffset: 8001,
      totalLength: 16201,
    },
  });
  expect(await call("history.read", { id, offset: 8001, maxChars: 16000 })).toMatchObject({
    ok: true,
    result: {
      text: "y".repeat(8200),
      offset: 8001,
      nextOffset: null,
    },
  });
  expect(await call("history.read", { id, offset: 16201 })).toMatchObject({
    ok: true,
    result: { text: "", offset: 16201, nextOffset: null },
  });
  for (const input of [
    { offset: 8000 },
    { offset: 16202 },
    { offset: -1 },
    { offset: 0.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { maxChars: 1 },
    { maxChars: 16001 },
  ])
    expect(await call("history.read", { id, ...input })).toMatchObject({ ok: false });
  const excerptId = message("x".repeat(199) + "😀" + "needle" + "y".repeat(500));
  expect(await call("history.search", { query: "needle" })).toMatchObject({
    ok: true,
    result: {
      hits: [
        {
          id: excerptId,
          match: { start: 201, end: 207 },
          excerpt: { start: 101, end: 501, text: "x".repeat(98) + "😀needle" + "y".repeat(294) },
        },
      ],
    },
  });
  const longQuery = "y".repeat(500);
  const search = await call("history.search", { query: longQuery });
  if (!search.ok) throw new Error(search.error);
  for (const hit of (
    search.result as { hits: Array<{ excerpt: { text: string; start: number; end: number } }> }
  ).hits) {
    expect(hit.excerpt.text.length).toBeLessThanOrEqual(400);
    expect(hit.excerpt.end - hit.excerpt.start).toBe(hit.excerpt.text.length);
    expect(hit.excerpt.text).not.toMatch(/[\uD800-\uDFFF]/u);
  }
});

it("projects tool names, IDs, arguments and results as inert text, omitting hidden and binary blocks", async () => {
  const { append, call, socket, session, agentId } = await historyFixture();
  const id = append({
    kind: "message",
    id: randomUUID(),
    message: answer(
      [
        { type: "text", text: "Visible", textSignature: "private-text-signature" },
        {
          type: "thinking",
          thinking: "private-thought",
          thinkingSignature: "private-thinking-signature",
        },
        {
          type: "toolCall",
          id: "old-call",
          name: "process.exec",
          arguments: { command: "printf historical-only" },
          thoughtSignature: "private-call-signature",
        },
      ],
      "toolUse",
    ),
  });
  const resultId = append({
    kind: "message",
    id: randomUUID(),
    message: {
      role: "toolResult",
      timestamp: 2345,
      toolCallId: "old-call",
      toolName: "process.exec",
      isError: false,
      content: [
        { type: "text", text: "historical-result" },
        { type: "image", data: "private-image-bytes", mimeType: "image/png" },
      ],
      details: { secret: "private-result-details" },
    },
  });
  const sent = socket.sent.length;
  const context = session.context(agentId);
  expect(await call("history.read", { id })).toMatchObject({
    ok: true,
    result: {
      role: "assistant",
      toolCalls: [{ id: "old-call", name: "process.exec" }],
      text: 'Visible\n[非文字内容已省略]\n工具调用 process.exec (old-call)\n{"command":"printf historical-only"}',
      nextId: resultId,
    },
  });
  expect(await call("history.read", { id: resultId })).toMatchObject({
    ok: true,
    result: {
      role: "toolResult",
      toolCallId: "old-call",
      toolName: "process.exec",
      isError: false,
      text: "工具结果 process.exec (old-call)\nhistorical-result\n[非文字内容已省略]",
    },
  });
  for (const query of ["process.exec", "old-call", "historical-only", "historical-result"])
    expect(await call("history.search", { query })).toMatchObject({
      ok: true,
      result: {
        hits: expect.arrayContaining([
          expect.objectContaining({ id: expect.any(String), agentId }),
        ]),
      },
    });
  expect(await call("history.search", { query: "private-" })).toMatchObject({
    ok: true,
    result: { hits: [] },
  });
  expect(await call("history.search", { query: "Visible" })).toMatchObject({
    ok: true,
    result: { hits: [{ id }] },
  });
  expect(await call("history.search", { query: "visible" })).toMatchObject({
    ok: true,
    result: { hits: [] },
  });
  expect(socket.sent).toHaveLength(sent);
  expect(session.context(agentId)).toEqual(context);
});

it("rejects malformed pagination, query changes, foreign cursors and records without leaking their existence", async () => {
  const { app, nodeId, socket, identity, session, run, agentId, message, call } =
    await historyFixture();
  expect(await call("history.search", { query: "missing" })).toEqual({
    ok: true,
    result: { hits: [], scanned: 0, nextCursor: null },
  });
  const firstId = message("😀 Example");
  for (let i = 0; i < 100; i++) message("padding");
  const search = await call("history.search", { query: "Example" });
  if (!search.ok) throw new Error(search.error);
  const cursor = (search.result as { nextCursor: Record<string, unknown> }).nextCursor;
  for (const invalid of [
    null,
    "broken",
    {},
    { ...cursor, after: -1 },
    { ...cursor, through: "1" },
    { ...cursor, after: 1.5 },
    { ...cursor, through: Number.MAX_SAFE_INTEGER + 1 },
    { ...cursor, after: Number.MAX_SAFE_INTEGER },
    { ...cursor, through: Number.MAX_SAFE_INTEGER },
    { ...cursor, agentId: randomUUID() },
    { ...cursor, query: "example" },
    { ...cursor, extra: true },
  ])
    expect(await call("history.search", { query: "Example", cursor: invalid })).toMatchObject({
      ok: false,
    });
  expect(await call("history.search", { query: "example", cursor })).toMatchObject({ ok: false });
  expect(await call("history.search", { query: "" })).toMatchObject({ ok: false });
  expect(await call("history.search", { query: "\ud83d" })).toMatchObject({ ok: false });
  const otherId = addAgent(app, nodeId, "Other history");
  const direct = app.chat.getOrCreateAgentDirectChannel(otherId)!;
  app.chat.createMessage(direct.id, "Start another independent history.");
  const otherRun = (await waitForRuns(socket, 0, [otherId])).get(otherId)!;
  const foreignId = randomUUID();
  expect(
    session.append(otherRun.runId, nodeId, otherId, {
      kind: "message",
      id: foreignId,
      message: { role: "user", content: "foreign secret", timestamp: 1 },
    }),
  ).toBe(true);
  const missing = await call("history.read", { id: randomUUID() });
  expect(missing).toEqual({ ok: false, error: "History record not found" });
  expect(await call("history.read", { id: foreignId })).toEqual(missing);
  expect(await call("history.search", { query: "foreign secret" })).toMatchObject({
    ok: true,
    result: { hits: [] },
  });
  for (const name of ["history.search", "history.read"]) {
    const input = name === "history.read" ? { id: firstId } : { query: "Example" };
    expect(await call(name, { ...input, agentId: otherId })).toMatchObject({ ok: false });
    for (const changed of [{ agentId: otherId }, { runId: randomUUID() }, { nodeId: randomUUID() }])
      expect(
        await app.tools.execute({ ...identity, ...changed }, "tools.call", { name, input }),
      ).toEqual({ ok: false, error: "Agent run is no longer active" });
  }
  expect(await call("history.read", { id: firstId })).toMatchObject({
    ok: true,
    result: { previousId: null, nextId: expect.any(String) },
  });
  app.runs?.close();
  app.chat.completeAgentRun(run.runId, agentId);
  expect(await call("history.read", { id: firstId })).toEqual({
    ok: false,
    error: "Agent run is no longer active",
  });
});

it("preserves confirmed records across compaction and database reopening without altering any stored state", async () => {
  const { app, db, socket, identity, session, agentId, run, append, message, call } =
    await historyFixture();
  const oldId = message("[频道 old-room；可见范围 private] original needle");
  const configId = append({
    kind: "configuration",
    id: randomUUID(),
    configuration: {
      provider: "openai",
      modelId: "synthetic",
      systemPrompt: "configuration-only needle",
      tools: [],
      piAgentVersion: "0.86.0",
      piAiVersion: "0.86.0",
      formatVersion: 1,
    },
  });
  const usageId = append({
    kind: "summary_usage",
    id: randomUUID(),
    stopReason: "stop",
    usage: { marker: "usage-only needle" },
    reportedUsage: null,
  });
  const keptId = message("retained context");
  expect(session.queueCorrection(agentId, { text: "pending-only needle" }, 3456)).toBe(true);
  const pending = session.pendingCorrections(agentId, run.actionScopeId);
  const before = await call("history.read", { id: oldId });
  append({
    kind: "compaction",
    id: randomUUID(),
    firstKeptEntryId: keptId,
    throughEntryId: keptId,
    summary: "summary-only needle",
    tokensBefore: 10000,
    summaryRequestIds: [randomUUID()],
  });
  const context = session.context(agentId);
  expect(context.map((entry) => entry.id)).toEqual([keptId]);
  const sent = socket.sent.length;
  const durableBefore = db.serialize();
  // A fresh SQLite connection and tool boundary prove IDs are not held in process-local caches.
  const reopened = new Database(db.name);
  try {
    const tools = new AgentTools(
      reopened,
      app.chat,
      app.workspace,
      app.attachments,
      new AgentProcessOperationBroker(reopened, app.nodes),
    );
    const read = (name: string, input: unknown) =>
      tools.execute(identity, "tools.call", { name, input });
    expect(await read("history.read", { id: oldId })).toEqual(before);
    expect(await read("history.search", { query: "needle" })).toMatchObject({
      ok: true,
      result: {
        scanned: 2,
        hits: [{ id: oldId }],
        nextCursor: null,
      },
    });
    expect(await read("history.read", { id: keptId })).toMatchObject({
      ok: true,
      result: { previousId: oldId, nextId: null },
    });
    for (const id of [configId, usageId, pending[0]!.id, randomUUID()])
      expect(await read("history.read", { id })).toEqual({
        ok: false,
        error: "History record not found",
      });
  } finally {
    reopened.close();
  }
  expect(session.context(agentId)).toEqual(context);
  expect(session.pendingCorrections(agentId, run.actionScopeId)).toEqual(pending);
  expect(socket.sent).toHaveLength(sent);
  expect(db.serialize()).toEqual(durableBefore);
});

it("keeps excerpt edges outside emoji and reports the full match range even when it exceeds the excerpt", async () => {
  const { message, call } = await historyFixture();
  const left = message("x".repeat(200) + "😀" + "y".repeat(99) + "needle");
  const right = message("needle" + "y".repeat(393) + "😀tail");
  expect(await call("history.search", { query: "needle" })).toMatchObject({
    ok: true,
    result: {
      hits: [
        {
          id: left,
          match: { start: 301, end: 307 },
          excerpt: { start: 200, end: 307, text: "😀" + "y".repeat(99) + "needle" },
        },
        {
          id: right,
          match: { start: 0, end: 6 },
          excerpt: { start: 0, end: 399, text: "needle" + "y".repeat(393) },
        },
      ],
    },
  });
  const long = message("z".repeat(501));
  expect(await call("history.search", { query: "z".repeat(501) })).toMatchObject({
    ok: true,
    result: {
      hits: [
        {
          id: long,
          match: { start: 0, end: 501 },
          excerpt: { start: 0, end: 400, text: "z".repeat(400) },
        },
      ],
    },
  });
});
