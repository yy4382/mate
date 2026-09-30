import {
  sessionFragment,
  sessionFragmentCharacters,
  type SessionCommit,
  type NodeControlMessage,
  type ModelContextMessage,
} from "@mate/protocol";
import { assistantMessage } from "../helpers/session.js";

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlPlaneApp } from "../../src/control-plane/http.js";
import type { NodeSocket } from "../../src/control-plane/nodes/directory.js";

const password = "agent-run-transcript-owner-password";
const fixtures: Array<{
  app: ReturnType<typeof createControlPlaneApp>;
  directory: string;
  db: InstanceType<typeof Database>;
}> = [];

afterEach(() => {
  for (const { app, directory, db } of fixtures.splice(0)) {
    db.close();
    app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeNodeSocket implements NodeSocket {
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
  terminate() {}
}

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-run-transcript-"));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  const app = createControlPlaneApp({ dataDir: join(directory, "control-plane"), passwordFile });
  const db = new Database(join(directory, "control-plane", "control-plane.sqlite"));
  fixtures.push({ app, directory, db });
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  const token = await app.request("/api/owner/nodes/pairing-tokens", {
    method: "POST",
    headers: { cookie },
  });
  const pairingToken = ((await token.json()) as { pairingToken: string }).pairingToken;
  const socket = new FakeNodeSocket();
  app.nodes.open(socket);
  const challenge = JSON.parse(socket.sent[0]!) as { nonce: string };
  const keyPair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const nodeId = randomUUID();
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.pair",
      requestId: randomUUID(),
      nodeId,
      pairingToken,
      publicKey: keyPair.publicKey,
      signature: sign(null, Buffer.from(challenge.nonce), keyPair.privateKey).toString("base64url"),
    }),
  );
  return { app, cookie, db, nodeId, socket, directory };
}

/** Provision one Agent on the fake node and return its private owner conversation. */
async function prepareAgent(
  fixture: Awaited<ReturnType<typeof setup>>,
  name: string,
): Promise<{ agentId: string; dm: string }> {
  const { app, cookie, nodeId } = fixture;
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name,
    role: "Records its own turns",
    description: "Synthetic run-transcript fixture.",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  app.agents.complete(
    agentId,
    {
      username: "mate_" + agentId.replaceAll("-", "").slice(0, 27),
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${agentId}`,
      workspaceMarker: "a".repeat(64),
    },
    app.chat,
  );
  const dm = app.chat.getOrCreateAgentDirectChannel(agentId)!.id;
  const credential = await app.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-transcript-key" }),
  });
  expect(credential.status).toBe(204);
  return { agentId, dm };
}

async function waitForRun(
  socket: FakeNodeSocket,
  fromIndex: number,
): Promise<Extract<NodeControlMessage, { type: "control.agent.run" }>> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    for (const text of socket.sent.slice(fromIndex)) {
      const message = JSON.parse(text) as Record<string, unknown>;
      if (message.type === "control.agent.run")
        return message as unknown as Extract<NodeControlMessage, { type: "control.agent.run" }>;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The queued Agent input did not start a run");
}

async function commit(
  fixture: Awaited<ReturnType<typeof setup>>,
  run: { runId: string; agentId: string },
  entry: SessionCommit,
) {
  const before = fixture.socket.sent.length;
  await fixture.app.nodes.receive(
    fixture.socket,
    JSON.stringify({
      type: "node.agent.run.transcript",
      requestId: entry.id,
      runId: run.runId,
      agentId: run.agentId,
      entry,
    }),
  );
  return JSON.parse(fixture.socket.sent[before]!).accepted;
}
async function context(
  fixture: Awaited<ReturnType<typeof setup>>,
  run: { runId: string; agentId: string },
) {
  await fixture.app.nodes.receive(
    fixture.socket,
    JSON.stringify({
      type: "node.agent.run.context",
      requestId: randomUUID(),
      runId: run.runId,
      agentId: run.agentId,
      cursor: 0,
      limit: 100,
    }),
  );
  return (JSON.parse(fixture.socket.sent.at(-1)!) as { messages: ModelContextMessage[] }).messages;
}
async function finish(
  fixture: Awaited<ReturnType<typeof setup>>,
  run: { runId: string; agentId: string },
) {
  await fixture.app.nodes.receive(
    fixture.socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: randomUUID(),
      runId: run.runId,
      agentId: run.agentId,
      ok: true,
    }),
  );
}

it("round-trips complete messages across conversations without rewriting prior observations", async () => {
  const fixture = await setup(),
    { app, socket } = fixture;
  const { agentId, dm } = await prepareAgent(fixture, "Complete partner");
  app.chat.createMessage(dm, "最初的私信");
  const run = await waitForRun(socket, 0);
  const input = (await context(fixture, run))[0]!;
  expect(
    await commit(fixture, run, { kind: "message", id: input.id, message: input.message }),
  ).toBe(true);
  const message = assistantMessage("  first block\n");
  message.content.push(
    { type: "thinking", thinking: "Synthetic reasoning", thinkingSignature: "synthetic-signature" },
    { type: "text", text: " second block  " },
    { type: "toolCall", id: "call-original", name: "tools.list", arguments: {} },
  );
  message.stopReason = "toolUse";
  const entry: SessionCommit = { kind: "message", id: randomUUID(), message };
  expect(await commit(fixture, run, entry)).toBe(true);
  expect(await commit(fixture, run, entry)).toBe(true);
  expect(await commit(fixture, run, { ...entry, message: assistantMessage("changed") })).toBe(
    false,
  );
  const result: SessionCommit = {
    kind: "message",
    id: randomUUID(),
    message: {
      role: "toolResult",
      toolCallId: "call-original",
      toolName: "tools.list",
      content: [{ type: "text", text: "observed original tool catalog" }],
      isError: false,
      timestamp: 3,
    },
  };
  expect(await commit(fixture, run, result)).toBe(true);
  const silent = assistantMessage("");
  silent.content = [];
  expect(await commit(fixture, run, { kind: "message", id: randomUUID(), message: silent })).toBe(
    true,
  );
  const before = await context(fixture, run);
  await finish(fixture, run);
  expect(await commit(fixture, run, entry)).toBe(false);
  const channel = app.chat.createChannel({
    name: "Public",
    description: "Synthetic",
    visibility: "public",
  });
  app.chat.inviteAgentToChannel(channel.id, agentId);
  app.chat.updateChannel(dm, { visibility: "private", description: "changed metadata" });
  const offset = socket.sent.length;
  app.chat.createMessage(channel.id, "第二个对话");
  const next = await waitForRun(socket, offset);
  const after = await context(fixture, next);
  expect(next.sessionId).toBe(run.sessionId);
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after[1]!.message).toEqual(message);
  expect(after[2]!.message).toEqual(result.message);
  expect(after[3]!.message).toEqual(silent);
  expect(app.chat.listMessages(dm, undefined, 20)!.messages).toHaveLength(1);
});

it("retains error and aborted response facts rather than fabricating successful assistant replies", async () => {
  const fixture = await setup();
  const { dm } = await prepareAgent(fixture, "Error partner");
  fixture.app.chat.createMessage(dm, "Synthetic error request");
  const run = await waitForRun(fixture.socket, 0);
  for (const stopReason of ["error", "aborted"] as const) {
    const message = {
      ...assistantMessage("partial provider output"),
      stopReason,
      errorMessage: "provider supplied failure",
    };
    expect(await commit(fixture, run, { kind: "message", id: randomUUID(), message })).toBe(true);
  }
  const restored = await context(fixture, run);
  expect(
    restored.filter((entry) => entry.message.role === "assistant").map((entry) => entry.message),
  ).toMatchObject([
    { stopReason: "error", errorMessage: "provider supplied failure" },
    { stopReason: "aborted", errorMessage: "provider supplied failure" },
  ]);
});

it("commits only complete ordered fragments, retries once, and discards partial old-run submissions", async () => {
  const f = await setup(),
    { agentId, dm } = await prepareAgent(f, "Fragments");
  f.app.chat.createMessage(dm, "Fragmented reply");
  const run = await waitForRun(f.socket, 0);
  const entry = {
    kind: "message" as const,
    id: randomUUID(),
    message: assistantMessage("x".repeat(1_100_000)),
  };
  const serialized = JSON.stringify(entry);
  const send = async (offset: number, body = serialized) => {
    await f.app.nodes.receive(
      f.socket,
      JSON.stringify({
        type: "node.agent.run.transcript",
        runId: run.runId,
        agentId,
        requestId: entry.id,
        entry: sessionFragment(body, offset),
      }),
    );
    return JSON.parse(f.socket.sent.at(-1)!).accepted;
  };
  const count = () =>
    (
      f.db
        .prepare("SELECT count(*) AS n FROM owner_agent_session_records WHERE id=?")
        .get(entry.id) as { n: number }
    ).n;
  expect(await send(0)).toBe(true);
  expect(count()).toBe(0);
  expect(await send(sessionFragmentCharacters * 2)).toBe(false);
  expect(count()).toBe(0);
  for (let offset = 0; offset < serialized.length; offset += sessionFragmentCharacters)
    expect(await send(offset)).toBe(true);
  expect(count()).toBe(1);
  // A lost final acknowledgement causes a retry of the same complete identity, never another row.
  for (let offset = 0; offset < serialized.length; offset += sessionFragmentCharacters)
    expect(await send(offset)).toBe(true);
  expect(count()).toBe(1);
  const changed = JSON.stringify({
    ...entry,
    message: assistantMessage("changed".repeat(100_000)),
  });
  for (let offset = 0; offset < changed.length; offset += sessionFragmentCharacters)
    expect(await send(offset, changed)).toBe(offset + sessionFragmentCharacters < changed.length);
  expect(count()).toBe(1);
  expect(await send(0)).toBe(true);
  await finish(f, run);
  expect(await send(sessionFragmentCharacters)).toBe(false);
  expect(await send(0)).toBe(false);
  expect(count()).toBe(1);
});

it("does not move already paged inputs when a late receipt arrives during context loading", async () => {
  const f = await setup(),
    { agentId, dm } = await prepareAgent(f, "Paging");
  for (const text of ["first", "second", "third"]) f.app.chat.createMessage(dm, text);
  const run = await waitForRun(f.socket, 0);
  const page = async (cursor: number) => {
    await f.app.nodes.receive(
      f.socket,
      JSON.stringify({
        type: "node.agent.run.context",
        requestId: randomUUID(),
        runId: run.runId,
        agentId,
        cursor,
        limit: 2,
      }),
    );
    return JSON.parse(f.socket.sent.at(-1)!) as {
      messages: ModelContextMessage[];
      nextCursor: number | null;
    };
  };
  const first = await page(0);
  expect(first.messages).toHaveLength(2);
  f.app.chat.updateChannel(dm, { archived: true });
  f.app.chat.notifyAgentReceiptCorrection(agentId, randomUUID(), "succeeded");
  const second = await page(first.nextCursor!);
  expect(
    second.messages.some((entry) => first.messages.some((prior) => prior.id === entry.id)),
  ).toBe(false);
  expect(second.messages.map((entry) => entry.message.content)).toEqual([
    expect.stringContaining("third"),
    expect.stringContaining("Mate 收据更正"),
  ]);
});

it("confirms one compaction checkpoint before exposing it to a resumed run", async () => {
  const f = await setup(),
    { agentId, dm } = await prepareAgent(f, "Compaction checkpoint");
  f.app.chat.createMessage(dm, "Old observation");
  const run = await waitForRun(f.socket, 0);
  const original = (await context(f, run))[0]!;
  expect(
    await commit(f, run, { kind: "message", id: original.id, message: original.message }),
  ).toBe(true);
  const retained = {
    kind: "message" as const,
    id: randomUUID(),
    message: assistantMessage("Recent"),
  };
  expect(await commit(f, run, retained)).toBe(true);
  const summaryUsage = {
    kind: "summary_usage" as const,
    id: randomUUID(),
    stopReason: "stop" as const,
    usage: { input: 123, output: 45, cacheRead: 0, cacheWrite: 0, totalTokens: 168 },
    reportedUsage: {
      sourceApi: "openai-responses",
      inputBasis: "includes_cache" as const,
      input: 123,
      output: 45,
    },
  };
  expect(await commit(f, run, summaryUsage)).toBe(true);
  expect(await commit(f, run, summaryUsage)).toBe(true);
  const unconfirmed = {
    kind: "compaction" as const,
    id: randomUUID(),
    firstKeptEntryId: randomUUID(),
    throughEntryId: retained.id,
    summary: "Must not become visible",
    tokensBefore: 321,
    summaryRequestIds: [summaryUsage.id],
  };
  expect(await commit(f, run, unconfirmed)).toBe(false);
  expect((await context(f, run)).every((entry) => entry.checkpoint === undefined)).toBe(true);
  const checkpoint = {
    kind: "compaction" as const,
    id: randomUUID(),
    firstKeptEntryId: retained.id,
    throughEntryId: retained.id,
    summary: "Earlier task state",
    tokensBefore: 321,
    summaryRequestIds: [summaryUsage.id],
  };
  expect(await commit(f, run, checkpoint)).toBe(true);
  expect(await commit(f, run, checkpoint)).toBe(true);
  expect(await commit(f, run, { ...checkpoint, summary: "Changed" })).toBe(false);
  expect(
    (await context(f, run)).find((entry) => entry.id === retained.id)?.checkpoint,
  ).toMatchObject({
    id: checkpoint.id,
    summary: "Earlier task state",
  });
  await finish(f, run);
  const offset = f.socket.sent.length;
  f.app.chat.createMessage(dm, "Continue after restart");
  const next = await waitForRun(f.socket, offset);
  expect((await context(f, next)).find((entry) => entry.id === retained.id)?.checkpoint?.id).toBe(
    checkpoint.id,
  );
  expect(
    f.db
      .prepare(
        "SELECT COUNT(*) AS n FROM owner_agent_session_records WHERE agent_id=? AND kind='message'",
      )
      .get(agentId),
  ).toEqual({ n: 2 });
  expect(
    f.db
      .prepare(
        "SELECT COUNT(*) AS n FROM owner_agent_session_records WHERE agent_id=? AND kind='summary_usage'",
      )
      .get(agentId),
  ).toEqual({ n: 1 });
});

it("counts each confirmed model response once despite repeated transcript acknowledgements", async () => {
  const f = await setup();
  const { agentId, dm } = await prepareAgent(f, "Usage acknowledgements");
  f.app.chat.createMessage(dm, "Record usage");
  const run = await waitForRun(f.socket, 0);
  const response: SessionCommit = {
    kind: "message",
    id: randomUUID(),
    message: assistantMessage("Response"),
    modelRequest: true,
    reportedUsage: {
      sourceApi: "anthropic-messages",
      inputBasis: "excludes_cache",
      input: 10,
      cacheRead: 20,
      cacheWrite: 30,
      output: 7,
      reasoning: 3,
    },
  };
  expect(await commit(f, run, response)).toBe(true);
  expect(await commit(f, run, response)).toBe(true);
  expect(await commit(f, run, { ...response, reportedUsage: null })).toBe(false);
  const summary: SessionCommit = {
    kind: "summary_usage",
    id: randomUUID(),
    stopReason: "length",
    usage: { input: 80, cacheRead: 20, output: 4, cacheWrite: 0, totalTokens: 104 },
    reportedUsage: {
      sourceApi: "openai-responses",
      inputBasis: "includes_cache",
      input: 100,
      cacheRead: 20,
      output: 4,
    },
  };
  expect(await commit(f, run, summary)).toBe(true);
  expect(await commit(f, run, summary)).toBe(true);
  const result = await f.app.request(`/api/owner/agents/${agentId}/usage`, {
    headers: { cookie: f.cookie },
  });
  expect(result.status).toBe(200);
  const usage = await result.json();
  expect(usage.total.requestCount).toBe(2);
  expect(usage.normal.requestCount).toBe(1);
  expect(usage.summary.requestCount).toBe(1);
  expect(usage.normal.tokens.uncachedInput.value).toBe(10);
  expect(usage.normal.tokens.allInput.value).toBe(60);
  expect(usage.normal.tokens.total.value).toBe(67);
  expect(usage.normal.tokens.reasoningOutput.value).toBe(3);
  expect(usage.total.cacheHitRate.value).toBe(0.25);
  expect(usage.latestNormal.id).toBe(response.id);
  expect(usage.latestNormal.recordedAt).toEqual(expect.any(Number));
});
