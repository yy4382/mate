import { Harness, createRegistry, type EntryDraft } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { answer } from "../support/agent/pi.js";
import {
  cleanupAgentToolFixture,
  createAgentToolFixture,
  authorizeModel,
  addAgent,
  waitForRuns,
} from "../support/agent/agent-tool-fixture.js";

const harnesses: Harness[] = [];
async function historyFixture() {
  const fixture = await createAgentToolFixture();
  const { app, cookie, nodeId, socket, db } = fixture;
  const agentId = addAgent(app, nodeId, "History reader");
  const direct = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  await authorizeModel(app, cookie);
  app.chat.messages.createMessage({ channelId: direct.id, text: "Read confirmed history." });
  const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
  const identity = { runId: run.runId, nodeId, agentId, toolCallId: "history-observation" };
  const directory = join(dirname(db.name), "durable");
  mkdirSync(directory, { recursive: true });
  const storage = await openNodeSqliteStorage(join(directory, `${agentId}.sqlite`));
  const harness = await Harness.open(
    storage,
    { models: builtinModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  harnesses.push(harness);
  const conversation = await harness.root(BACKGROUND_CONTEXT);
  const append = async (entry: EntryDraft) => {
    const submission = await conversation.submit({ type: "write", entry }, BACKGROUND_CONTEXT);
    const status = await submission.wait(BACKGROUND_CONTEXT);
    if (status.entry === undefined) throw new Error("Entry not committed");
    return `${agentId}:${status.entry}`;
  };
  const message = (content: string) =>
    append({ kind: "pi.user", model: [{ role: "user", content, timestamp: 1234 }] });
  const call = (name: string, input: unknown) =>
    app.tools.execute(identity, "tools.call", { name, input });
  return {
    ...fixture,
    agentId,
    run,
    identity,
    harness,
    storage,
    conversation,
    append,
    message,
    call,
  };
}

it("reads native confirmed experience, excludes failed diagnostics and keeps old calls inert", async () => {
  const { app, identity, agentId, append, message, call, socket } = await historyFixture();
  const first = await message("[私信] 中文.* 中文.*");
  const id = await append({
    kind: "pi.assistant",
    model: [
      answer(
        [
          { type: "text", text: "Visible", textSignature: "private-signature" },
          { type: "thinking", thinking: "private-thought", thinkingSignature: "private-thinking" },
          {
            type: "toolCall",
            id: "old-call",
            name: "process.exec",
            arguments: { command: "printf historical-only" },
          },
        ],
        "toolUse",
      ),
    ],
  });
  const resultId = await append({
    kind: "pi.toolResult",
    model: [
      {
        role: "toolResult",
        timestamp: 2345,
        toolCallId: "old-call",
        toolName: "process.exec",
        isError: false,
        content: [
          { type: "text", text: "historical-result" },
          { type: "image", data: "private-bytes", mimeType: "image/png" },
        ],
      },
    ],
  });
  for (const stopReason of ["error", "aborted", "deferred"] as const)
    await append({
      kind: "pi.assistant",
      model: [{ ...answer([{ type: "text", text: "private-failed" }]), stopReason }],
    });
  await append({ kind: "diagnostic", data: { message: "private-diagnostic" } });
  const sent = socket.sent.length;
  expect(await app.tools.execute(identity, "tools.list", {})).toMatchObject({
    ok: true,
    result: {
      tools: expect.arrayContaining([{ name: "history.read", description: expect.any(String) }]),
    },
  });
  expect(await call("history.search", { query: "中文.*" })).toMatchObject({
    ok: true,
    result: {
      hits: [
        {
          id: first,
          agentId,
          match: { start: 5, end: 9 },
          excerpt: { start: 0, end: 14, text: "[私信] 中文.* 中文.*" },
        },
      ],
    },
  });
  expect(await call("history.read", { id })).toMatchObject({
    ok: true,
    result: {
      previousId: first,
      nextId: resultId,
      role: "assistant",
      toolCalls: [{ id: "old-call", name: "process.exec" }],
      text: 'Visible\n[非文字内容已省略]\n工具调用 process.exec (old-call)\n{"command":"printf historical-only"}',
    },
  });
  expect(await call("history.read", { id: resultId })).toMatchObject({
    ok: true,
    result: {
      previousId: id,
      nextId: null,
      text: "工具结果 process.exec (old-call)\nhistorical-result\n[非文字内容已省略]",
    },
  });
  expect(await call("history.search", { query: "private-" })).toMatchObject({
    ok: true,
    result: { hits: [] },
  });
  expect(socket.sent).toHaveLength(sent);
});

it("bounds searches to their original native range through empty pages and concurrent appends", async () => {
  const { message, call } = await historyFixture();
  for (let i = 0; i < 100; i++) await message("padding");
  const ids = [];
  for (let i = 0; i < 25; i++) ids.push(await message("needle needle"));
  const first = await call("history.search", { query: "needle" });
  expect(first).toMatchObject({
    ok: true,
    result: { hits: [], scanned: 100, nextCursor: expect.any(Object) },
  });
  if (!first.ok) throw new Error(first.error);
  const cursor = (first.result as { nextCursor: unknown }).nextCursor;
  const added = await message("needle appended later");
  const second = await call("history.search", { query: "needle", cursor });
  expect(second).toMatchObject({
    ok: true,
    result: {
      scanned: 20,
      hits: ids.slice(0, 20).map((id) => ({ id })),
      nextCursor: expect.any(Object),
    },
  });
  if (!second.ok) throw new Error(second.error);
  expect(
    await call("history.search", {
      query: "needle",
      cursor: (second.result as { nextCursor: unknown }).nextCursor,
    }),
  ).toMatchObject({
    ok: true,
    result: { scanned: 5, hits: ids.slice(20).map((id) => ({ id })), nextCursor: null },
  });
  let page = await call("history.search", { query: "appended later" });
  if (!page.ok) throw new Error(page.error);
  page = await call("history.search", {
    query: "appended later",
    cursor: (page.result as { nextCursor: unknown }).nextCursor,
  });
  expect(page).toMatchObject({ ok: true, result: { hits: [{ id: added }], nextCursor: null } });
});

it("keeps long text and excerpts on UTF-16 character boundaries", async () => {
  const { message, call } = await historyFixture();
  const previousId = await message("previous");
  const id = await message("x".repeat(7999) + "😀" + "y".repeat(8200));
  const nextId = await message("next");
  expect(await call("history.read", { id })).toMatchObject({
    ok: true,
    result: { text: "x".repeat(7999), nextOffset: 7999, totalLength: 16201, previousId, nextId },
  });
  expect(await call("history.read", { id, offset: 7999, maxChars: 2 })).toMatchObject({
    ok: true,
    result: { text: "😀", nextOffset: 8001 },
  });
  expect(await call("history.read", { id, offset: 8001, maxChars: 16000 })).toMatchObject({
    ok: true,
    result: { text: "y".repeat(8200), nextOffset: null },
  });
  for (const input of [
    { offset: 8000 },
    { offset: 16202 },
    { offset: -1 },
    { offset: 0.5 },
    { maxChars: 1 },
    { maxChars: 16001 },
  ])
    expect(await call("history.read", { id, ...input })).toMatchObject({ ok: false });
  const left = await message("x".repeat(200) + "😀" + "y".repeat(99) + "needle");
  const right = await message("needle" + "y".repeat(393) + "😀tail");
  expect(await call("history.search", { query: "needle" })).toMatchObject({
    ok: true,
    result: {
      hits: [
        { id: left, match: { start: 301, end: 307 }, excerpt: { start: 200, end: 307 } },
        { id: right, excerpt: { start: 0, end: 399 } },
      ],
    },
  });
  const long = await message("z".repeat(501));
  expect(await call("history.search", { query: "z".repeat(501) })).toMatchObject({
    ok: true,
    result: {
      hits: [{ id: long, match: { start: 0, end: 501 }, excerpt: { start: 0, end: 400 } }],
    },
  });
});

it("rejects foreign record identities, forged pagination and inactive tool callers", async () => {
  const { app, agentId, identity, message, call } = await historyFixture();
  const id = await message("Example");
  for (let i = 0; i < 100; i++) await message("padding");
  const search = await call("history.search", { query: "Example" });
  if (!search.ok) throw new Error(search.error);
  const cursor = (search.result as { nextCursor: Record<string, unknown> }).nextCursor;
  for (const invalid of [
    null,
    "broken",
    {},
    { ...cursor, after: -1 },
    { ...cursor, through: "1" },
    { ...cursor, through: Number.MAX_SAFE_INTEGER },
    { ...cursor, agentId: randomUUID() },
    { ...cursor, extra: true },
  ])
    expect(await call("history.search", { query: "Example", cursor: invalid })).toMatchObject({
      ok: false,
    });
  for (const query of ["", "\ud83d"])
    expect(await call("history.search", { query })).toMatchObject({ ok: false });
  expect(await call("history.search", { query: "example", cursor })).toMatchObject({ ok: false });
  const missing = await call("history.read", { id: randomUUID() });
  expect(missing).toEqual({ ok: false, error: "History record not found" });
  expect(await call("history.read", { id: id.replace(agentId, randomUUID()) })).toEqual(missing);
  for (const changed of [
    { agentId: randomUUID() },
    { runId: randomUUID() },
    { nodeId: randomUUID() },
  ])
    expect(
      await app.tools.execute({ ...identity, ...changed }, "tools.call", {
        name: "history.read",
        input: { id },
      }),
    ).toEqual({ ok: false, error: "Agent run is no longer active" });
  expect(await call("history.read", { id, agentId: randomUUID() })).toMatchObject({ ok: false });
});

it("keeps IDs and pre-compaction text through native compaction markers and storage reopening", async () => {
  const { agentId, message, append, call, harness, storage, conversation } = await historyFixture();
  const old = await message("original needle");
  await message("retained context");
  const kept = (
    await storage.scanEntries({ conversationId: conversation.id }, 1, undefined, BACKGROUND_CONTEXT)
  ).items[0]!;
  const before = await call("history.read", { id: old });
  await append({
    kind: "pi.compaction",
    head: kept.id,
    model: [{ role: "user", content: "summary of earlier work", timestamp: 2345 }],
  });
  await harness.close(BACKGROUND_CONTEXT);
  expect(await call("history.read", { id: old })).toEqual(before);
  expect(await call("history.search", { query: "needle" })).toMatchObject({
    ok: true,
    result: { hits: [{ id: old, agentId }], nextCursor: null },
  });
});

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close(BACKGROUND_CONTEXT);
  await cleanupAgentToolFixture();
});
