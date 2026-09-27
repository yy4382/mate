import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";

const mockSockets = vi.hoisted(() => ({ items: [] as Array<Record<string, any>> }));
vi.mock("ws", () => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = MockWebSocket.CONNECTING;
    sent: Record<string, unknown>[] = [];
    listeners = new Map<string, Array<{ callback: (event: any) => void; once: boolean }>>();

    constructor() {
      mockSockets.items.push(this);
      setTimeout(() => {
        if (this.readyState !== MockWebSocket.CONNECTING) return;
        this.readyState = MockWebSocket.OPEN;
        this.dispatch("open", {});
        this.serverSend({
          type: "control.challenge",
          nonce: randomBytes(32).toString("base64url"),
        });
      }, 0);
    }

    addEventListener(type: string, callback: (event: any) => void, options?: { once?: boolean }) {
      const values = this.listeners.get(type) ?? [];
      values.push({ callback, once: options?.once ?? false });
      this.listeners.set(type, values);
    }

    removeEventListener(type: string, callback: (event: any) => void) {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((listener) => listener.callback !== callback),
      );
    }

    send(data: string) {
      const request = JSON.parse(data) as Record<string, unknown>;
      this.sent.push(request);
      if (request.type === "node.authenticate")
        this.serverSend({
          type: "control.authenticated",
          requestId: request.requestId,
          nodeId: request.nodeId,
        });
      if (request.type === "node.ping")
        this.serverSend({
          type: "control.pong",
          requestId: request.requestId,
          acceptedAt: Date.now(),
        });
    }

    serverSend(message: Record<string, unknown>) {
      this.dispatch("message", { data: JSON.stringify(message) });
    }

    close(code = 1000, reason = "closed") {
      if (this.readyState === MockWebSocket.CLOSED || this.readyState === MockWebSocket.CLOSING)
        return;
      this.readyState = MockWebSocket.CLOSING;
      queueMicrotask(() => {
        this.readyState = MockWebSocket.CLOSED;
        this.dispatch("close", { code, reason });
      });
    }

    terminate() {
      this.close(1006, "terminated");
    }

    private dispatch(type: string, event: unknown) {
      const listeners = [...(this.listeners.get(type) ?? [])];
      for (const listener of listeners) {
        listener.callback(event);
        if (listener.once) this.removeEventListener(type, listener.callback);
      }
    }
  }
  return { WebSocket: MockWebSocket };
});

import { loadOrCreateNodeIdentity } from "../../src/nodes/identity.js";
import { runLinuxNodeWithTestDependencies } from "../../src/nodes/client.js";
import { AgentProcessOperations } from "../../src/nodes/process-operations.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForSocket(index: number): Promise<Record<string, any>> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const socket = mockSockets.items[index];
    if (socket) return socket;
    await delay(5);
  }
  throw new Error(`Node did not create connection ${index + 1}`);
}

async function waitForMessage(
  socket: Record<string, any>,
  type: string,
  fromIndex = 0,
  timeoutMs = 8000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = socket.sent.slice(fromIndex).find((entry: any) => entry.type === type);
    if (message) return message;
    await delay(5);
  }
  throw new Error(`Node did not send ${type}`);
}

function messagesOfType(socket: Record<string, any>, type: string, fromIndex = 0): any[] {
  return socket.sent.slice(fromIndex).filter((entry: any) => entry.type === type);
}

async function waitForMessages(
  socket: Record<string, any>,
  type: string,
  count: number,
  fromIndex = 0,
  timeoutMs = 8000,
): Promise<any[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = messagesOfType(socket, type, fromIndex);
    if (messages.length >= count) return messages;
    await delay(5);
  }
  throw new Error(`Node did not send ${count} ${type} messages`);
}

async function startNode(): Promise<{
  directory: string;
  database: InstanceType<typeof Database>;
  controller: AbortController;
  node: Promise<void>;
  socket: Record<string, any>;
}> {
  mockSockets.items.length = 0;
  const directory = mkdtempSync(join(tmpdir(), "mate-run-notice-client-")),
    database = new Database(":memory:"),
    controller = new AbortController();
  loadOrCreateNodeIdentity(directory);
  const node = runLinuxNodeWithTestDependencies(
    {
      controlPlaneUrl: "http://node-control.test",
      dataDirectory: directory,
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 3000,
    },
    controller.signal,
    {
      modelWorkerEntry: resolve("tests/fixtures/direct-message-model-worker.mjs"),
      processOperations: new AgentProcessOperations(database, async () => ({
        state: "succeeded",
        receipt: {},
      })),
    },
  );
  const socket = await waitForSocket(0);
  await waitForMessage(socket, "node.ping");
  return { directory, database, controller, node, socket };
}

async function stopNode(started: Awaited<ReturnType<typeof startNode>>): Promise<void> {
  started.controller.abort();
  for (const socket of mockSockets.items) socket.terminate();
  await started.node;
  started.database.close();
  rmSync(started.directory, { recursive: true, force: true });
}

/** Start one real Pi run through the node and answer its session-context request. */
async function startRun(
  socket: Record<string, any>,
  options: {
    /** Runs after the node asks for the session context and before it gets the answer. */
    onBoot?: (run: { runId: string; agentId: string; channelId: string }) => void;
  } = {},
): Promise<{ runId: string; agentId: string; sessionId: string; channelId: string; from: number }> {
  const runId = randomUUID(),
    agentId = randomUUID(),
    sessionId = randomUUID(),
    channelId = randomUUID(),
    from = socket.sent.length;
  socket.serverSend({
    type: "control.agent.run",
    requestId: randomUUID(),
    runId,
    agentId,
    sessionId,
    actionScopeId: randomUUID(),
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "synthetic-key-busy-notice",
    channelId,
    channelVisibility: "private",
    prompt: { name: "小林", role: "测试助手", description: "Synthetic notice fixture" },
  });
  const contextRequest = await waitForMessage(socket, "node.agent.run.context", from);
  options.onBoot?.({ runId, agentId, channelId });
  socket.serverSend({
    type: "control.agent.run.context",
    requestId: contextRequest.requestId,
    runId,
    messages: [
      {
        sequence: 1,
        role: "user",
        text: "第一条：先做当前工作。",
        sourceChannelId: channelId,
        sourceVisibility: "private",
        currentRunInput: true,
      },
    ],
    nextCursor: null,
  });
  return { runId, agentId, sessionId, channelId, from };
}

it("delivers a content-free notice into the Pi loop without preempting the tool in progress", async () => {
  const started = await startNode();
  const { socket } = started;
  try {
    const run = await startRun(socket);
    // The first turn calls a tool that the control plane has not answered yet.
    const toolRequest = await waitForMessage(socket, "node.agent.run.tool", run.from);
    expect(toolRequest).toMatchObject({ runId: run.runId, operation: "tools.list" });

    // Only notices for this run and this Agent may reach the loop; the body never travels.
    const busyText = "忙中到达的消息正文，不应出现在提示里。";
    const secondConversation = randomUUID();
    const noticeStart = socket.sent.length;
    socket.serverSend({
      type: "control.agent.run.notice",
      requestId: randomUUID(),
      runId: randomUUID(),
      agentId: run.agentId,
      conversationId: run.channelId,
    });
    socket.serverSend({
      type: "control.agent.run.notice",
      requestId: randomUUID(),
      runId: run.runId,
      agentId: randomUUID(),
      conversationId: run.channelId,
    });
    socket.serverSend({
      type: "control.agent.run.notice",
      requestId: randomUUID(),
      runId: run.runId,
      agentId: run.agentId,
      conversationId: run.channelId,
    });
    socket.serverSend({
      type: "control.agent.run.notice",
      requestId: randomUUID(),
      runId: run.runId,
      agentId: run.agentId,
      conversationId: secondConversation,
    });

    // The tool call still owns the turn: the notice must not preempt it.
    await delay(400);
    expect(messagesOfType(socket, "node.agent.run.transcript", noticeStart)).toHaveLength(0);
    expect(messagesOfType(socket, "node.agent.run.tool", noticeStart)).toHaveLength(0);

    socket.serverSend({
      type: "control.agent.run.tool_result",
      requestId: toolRequest.requestId,
      runId: run.runId,
      toolCallId: toolRequest.toolCallId,
      ok: true,
      result: { tools: [] },
    });

    // After the tool result the loop drains its steering queue one notice at a time, so both
    // notices are handled in order without dropping either. Each turn settles on its ACK.
    const acknowledge = (transcript: Record<string, any>) =>
      socket.serverSend({
        type: "control.agent.run.transcript_ack",
        requestId: transcript.requestId,
        runId: run.runId,
        accepted: true,
      });
    const first = await waitForMessage(socket, "node.agent.run.transcript", noticeStart);
    expect(first.text).toContain(run.channelId);
    expect(first.text).toContain("运行提示");
    expect(first.text).not.toContain(busyText);
    acknowledge(first);
    const second = (await waitForMessages(socket, "node.agent.run.transcript", 2, noticeStart))[1];
    expect(second.text).toContain(secondConversation);
    acknowledge(second!);
    const result = await waitForMessage(socket, "node.agent.run.result", noticeStart);
    expect(result).toMatchObject({ runId: run.runId, ok: true });
    // Exactly two notices reached the loop, so exactly two notice-bearing turns were produced.
    expect(messagesOfType(socket, "node.agent.run.transcript", noticeStart)).toHaveLength(2);
  } finally {
    await stopNode(started);
  }
}, 20000);

it("ignores a late notice after the run ended and never revives it", async () => {
  const started = await startNode();
  const { socket } = started;
  try {
    const run = await startRun(socket);
    const toolRequest = await waitForMessage(socket, "node.agent.run.tool", run.from);
    socket.serverSend({
      type: "control.agent.run.tool_result",
      requestId: toolRequest.requestId,
      runId: run.runId,
      toolCallId: toolRequest.toolCallId,
      ok: true,
      result: { tools: [] },
    });
    const transcript = await waitForMessage(socket, "node.agent.run.transcript", run.from);
    socket.serverSend({
      type: "control.agent.run.transcript_ack",
      requestId: transcript.requestId,
      runId: run.runId,
      accepted: true,
    });
    await waitForMessage(socket, "node.agent.run.result", run.from);

    // The run is over and the node holds no worker for it any more.
    const lateStart = socket.sent.length;
    socket.serverSend({
      type: "control.agent.run.notice",
      requestId: randomUUID(),
      runId: run.runId,
      agentId: run.agentId,
      conversationId: run.channelId,
    });
    await delay(400);
    expect(messagesOfType(socket, "node.agent.run.transcript", lateStart)).toHaveLength(0);
    expect(messagesOfType(socket, "node.agent.run.result", lateStart)).toHaveLength(0);
    expect(messagesOfType(socket, "node.agent.run.tool", lateStart)).toHaveLength(0);
  } finally {
    await stopNode(started);
  }
}, 20000);

it("keeps a cancelled or disconnected run dead when a late notice arrives", async () => {
  const started = await startNode();
  const { socket } = started;
  try {
    // A cancelled run and a notice that races it.
    const cancelled = await startRun(socket);
    await waitForMessage(socket, "node.agent.run.tool", cancelled.from);
    const cancelStart = socket.sent.length;
    socket.serverSend({
      type: "control.agent.run.cancel",
      requestId: randomUUID(),
      runId: cancelled.runId,
      agentId: cancelled.agentId,
      reason: "manual_pause",
    });
    socket.serverSend({
      type: "control.agent.run.notice",
      requestId: randomUUID(),
      runId: cancelled.runId,
      agentId: cancelled.agentId,
      conversationId: cancelled.channelId,
    });
    await delay(400);
    expect(messagesOfType(socket, "node.agent.run.transcript", cancelStart)).toHaveLength(0);
    expect(messagesOfType(socket, "node.agent.run.tool", cancelStart)).toHaveLength(0);
    expect(messagesOfType(socket, "node.agent.run.result", cancelStart)).toHaveLength(0);

    // A run whose node connection dropped, followed by a reconnect and a late notice.
    const dropped = await startRun(socket);
    await waitForMessage(socket, "node.agent.run.tool", dropped.from);
    socket.terminate();
    const reconnected = await waitForSocket(1);
    await waitForMessage(reconnected, "node.ping");
    const lateStart = reconnected.sent.length;
    reconnected.serverSend({
      type: "control.agent.run.notice",
      requestId: randomUUID(),
      runId: dropped.runId,
      agentId: dropped.agentId,
      conversationId: dropped.channelId,
    });
    await delay(400);
    expect(messagesOfType(reconnected, "node.agent.run.transcript", lateStart)).toHaveLength(0);
    expect(messagesOfType(reconnected, "node.agent.run.tool", lateStart)).toHaveLength(0);
    expect(messagesOfType(reconnected, "node.agent.run.result", lateStart)).toHaveLength(0);
  } finally {
    await stopNode(started);
  }
}, 20000);

it("keeps a notice that arrives in the same tick as the run request", async () => {
  const started = await startNode();
  const { socket } = started;
  try {
    const runId = randomUUID(),
      agentId = randomUUID(),
      sessionId = randomUUID(),
      channelId = randomUUID(),
      from = socket.sent.length;
    // Both messages are handed to the node before it can answer anything, so the notice lands
    // while the run is being set up and must still reach that run's loop.
    socket.serverSend({
      type: "control.agent.run",
      requestId: randomUUID(),
      runId,
      agentId,
      sessionId,
      actionScopeId: randomUUID(),
      provider: "openai",
      modelId: "gpt-4o-mini",
      apiKey: "synthetic-key-busy-notice",
      channelId,
      channelVisibility: "private",
      prompt: { name: "小林", role: "测试助手", description: "Synthetic notice fixture" },
    });
    socket.serverSend({
      type: "control.agent.run.notice",
      requestId: randomUUID(),
      runId,
      agentId,
      conversationId: channelId,
    });
    const contextRequest = await waitForMessage(socket, "node.agent.run.context", from);
    socket.serverSend({
      type: "control.agent.run.context",
      requestId: contextRequest.requestId,
      runId,
      messages: [
        {
          sequence: 1,
          role: "user",
          text: "第一条：先做当前工作。",
          sourceChannelId: channelId,
          sourceVisibility: "private",
          currentRunInput: true,
        },
      ],
      nextCursor: null,
    });
    const toolRequest = await waitForMessage(socket, "node.agent.run.tool", from);
    socket.serverSend({
      type: "control.agent.run.tool_result",
      requestId: toolRequest.requestId,
      runId,
      toolCallId: toolRequest.toolCallId,
      ok: true,
      result: { tools: [] },
    });
    const transcript = await waitForMessage(socket, "node.agent.run.transcript", from);
    expect(transcript.text).toContain("运行提示");
    expect(transcript.text).toContain(channelId);
    socket.serverSend({
      type: "control.agent.run.transcript_ack",
      requestId: transcript.requestId,
      runId,
      accepted: true,
    });
    expect(await waitForMessage(socket, "node.agent.run.result", from)).toMatchObject({
      runId,
      ok: true,
    });
  } finally {
    await stopNode(started);
  }
}, 20000);

it("keeps a notice that arrives while the run is still starting for that run", async () => {
  const started = await startNode();
  const { socket } = started;
  try {
    let bootNotice = "";
    // The notice lands after the node accepted the run but before the Pi loop exists.
    const run = await startRun(socket, {
      onBoot: (booting) => {
        bootNotice = booting.channelId;
        socket.serverSend({
          type: "control.agent.run.notice",
          requestId: randomUUID(),
          runId: booting.runId,
          agentId: booting.agentId,
          conversationId: booting.channelId,
        });
      },
    });
    const toolRequest = await waitForMessage(socket, "node.agent.run.tool", run.from);
    socket.serverSend({
      type: "control.agent.run.tool_result",
      requestId: toolRequest.requestId,
      runId: run.runId,
      toolCallId: toolRequest.toolCallId,
      ok: true,
      result: { tools: [] },
    });
    const transcript = await waitForMessage(socket, "node.agent.run.transcript", run.from);
    // The buffered notice reached the loop this run, not only the next one.
    expect(transcript.text).toContain("运行提示");
    expect(transcript.text).toContain(bootNotice);
    socket.serverSend({
      type: "control.agent.run.transcript_ack",
      requestId: transcript.requestId,
      runId: run.runId,
      accepted: true,
    });
    expect(await waitForMessage(socket, "node.agent.run.result", run.from)).toMatchObject({
      runId: run.runId,
      ok: true,
    });
  } finally {
    await stopNode(started);
  }
}, 20000);
