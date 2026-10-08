import Database from "better-sqlite3";
import type { NodeRequest } from "@mate/protocol";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const mockSockets = vi.hoisted(() => {
  const items: MockWebSocket[] = [];
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = MockWebSocket.CONNECTING;
    sent: NodeRequest[] = [];
    listeners = new Map<string, Array<{ callback: (event: unknown) => void; once: boolean }>>();

    constructor() {
      items.push(this);
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

    addEventListener(
      type: string,
      callback: (event: unknown) => void,
      options?: { once?: boolean },
    ) {
      const values = this.listeners.get(type) ?? [];
      values.push({ callback, once: options?.once ?? false });
      this.listeners.set(type, values);
    }

    removeEventListener(type: string, callback: (event: unknown) => void) {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((listener) => listener.callback !== callback),
      );
    }

    send(data: string) {
      // The production sender has already checked this message with NodeRequestSchema.
      const request: NodeRequest = JSON.parse(data);
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
  return { items, MockWebSocket };
});
vi.mock("ws", () => ({ WebSocket: mockSockets.MockWebSocket }));

import { loadOrCreateNodeIdentity } from "../../src/connection/node-identity.js";
import { runLinuxNodeWithTestDependencies } from "../../src/connection/node-client.js";
import { AgentProcessOperations } from "../../src/processes/operation-ledger.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitFor<T>(promise: Promise<T>, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for node process operation")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForSocket(index: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const socket = mockSockets.items[index];
    if (socket) return socket;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Node did not create connection ${index + 1}`);
}

async function waitForMessage(
  socket: InstanceType<typeof mockSockets.MockWebSocket>,
  type: NodeRequest["type"],
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const message = socket.sent.find((entry) => entry.type === type);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Node did not send ${type}`);
}

it("reconciles a running operation after its WebSocket disconnects without starting it twice", async () => {
  mockSockets.items.length = 0;
  const directory = mkdtempSync(join(tmpdir(), "mate-process-client-"));
  const database = new Database(":memory:");
  const started = deferred<void>();
  const finish = deferred<{ state: "succeeded"; receipt: unknown }>();
  const execute = vi.fn(async () => {
    started.resolve();
    return finish.promise;
  });
  const operations = new AgentProcessOperations(database, execute);
  const identity = loadOrCreateNodeIdentity(directory).identity;
  const controller = new AbortController();
  const node = runLinuxNodeWithTestDependencies(
    {
      controlPlaneUrl: "http://node-control.test",
      dataDirectory: directory,
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 3000,
    },
    controller.signal,
    { processOperations: operations },
  );

  try {
    const first = await waitForSocket(0);
    await waitForMessage(first, "node.ping");
    const operationId = randomUUID();
    const agentId = randomUUID();
    const operation = { kind: "exec", command: "printf once", cwd: "." };
    const firstRequestId = randomUUID();
    first.serverSend({
      type: "control.process.operation",
      requestId: firstRequestId,
      operationId,
      agentId,
      operation,
    });
    await waitFor(started.promise);
    first.close();

    const second = await waitForSocket(1);
    await waitForMessage(second, "node.ping");
    const secondRequestId = randomUUID();
    second.serverSend({
      type: "control.process.operation",
      requestId: secondRequestId,
      operationId,
      agentId,
      operation,
    });
    expect(execute).toHaveBeenCalledOnce();
    finish.resolve({ state: "succeeded", receipt: { stdout: "once" } });
    const receipt = await waitForMessage(second, "node.process.operation.result");
    expect(receipt).toMatchObject({
      requestId: secondRequestId,
      operationId,
      agentId,
      state: "succeeded",
      receipt: { stdout: "once" },
    });
    expect(operations.status(agentId, operationId)).toMatchObject({ state: "succeeded" });
    expect(identity.id).toBeTruthy();
  } finally {
    controller.abort();
    for (const socket of mockSockets.items) socket.terminate();
    await node;
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
