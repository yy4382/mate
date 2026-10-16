import {
  GatewayMessageSchema,
  NodeRequestSchema,
  type GatewayMessage,
  type JsonValue,
  type ToolName,
  type ToolResult,
} from "@mate/node-protocol";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

export interface FakeGatewayOptions {
  port?: number;
  /**
   * Called each time a node authenticates or pairs.
   * Return false to reject with pairing_rejected.
   */
  onConnect?: (nodeId: string, publicKey: string) => boolean | Promise<boolean>;
}

interface PendingToolCall {
  resolve: (result: ToolResult) => void;
  reject: (err: Error) => void;
  onOutput: (chunk: string) => void;
}

/**
 * A fake WebSocket gateway server that speaks the node-protocol.
 * Lets gateway tests run `startNode` against a real in-process server.
 */
export class FakeGateway {
  readonly #wss: WebSocketServer;
  readonly #server: http.Server;
  #socket: WebSocket | undefined;
  #nonce: string | undefined;
  #nodeId: string | undefined;
  #authenticated = false;
  #authentications = 0;
  readonly #pendingToolCalls = new Map<string, PendingToolCall>();
  readonly #options: FakeGatewayOptions;

  constructor(options: FakeGatewayOptions = {}) {
    this.#options = options;
    this.#server = http.createServer();
    this.#wss = new WebSocketServer({ noServer: true });

    this.#server.on("upgrade", (req, socket, head) => {
      this.#wss.handleUpgrade(req, socket, head, (ws) => {
        this.#wss.emit("connection", ws, req);
      });
    });

    this.#wss.on("connection", (ws: WebSocket) => {
      this.#socket = ws;
      ws.on("message", (data) => {
        void this.#handleMessage(String(data));
      });
      ws.on("close", () => {
        if (this.#socket === ws) {
          this.#socket = undefined;
          this.#authenticated = false;
        }
        // Reject any pending tool calls
        for (const [, pending] of this.#pendingToolCalls) {
          pending.reject(new Error("WebSocket closed"));
        }
        this.#pendingToolCalls.clear();
      });

      // Send the challenge
      this.#nonce = randomBytes(32).toString("base64url");
      this.#send({ type: "gateway.challenge", nonce: this.#nonce });
    });
  }

  /** Start the server. Returns the URL nodes should connect to. */
  start(): Promise<string> {
    return new Promise((resolve) => {
      const port = this.#options.port ?? 0;
      this.#server.listen(port, "127.0.0.1", () => {
        resolve(this.url);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#socket?.terminate();
      this.#wss.close(() => {
        this.#server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  get url(): string {
    const addr = this.#server.address();
    if (addr === null || typeof addr === "string") throw new Error("server not started");
    return `http://127.0.0.1:${addr.port}`;
  }

  get isAuthenticated(): boolean {
    return this.#authenticated;
  }

  get connectedNodeId(): string | undefined {
    return this.#nodeId;
  }

  /** How many times a node has authenticated or paired, across connections. */
  get authentications(): number {
    return this.#authentications;
  }

  /** Resolve once a node is authenticated on the current connection. */
  async waitForNode(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.#authenticated) {
      if (Date.now() > deadline) throw new Error("no node authenticated in time");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * Run a tool on the connected node; resolves with the result, and rejects if the connection closes first.
   * `onOutput` receives each streamed chunk.
   */
  runTool(
    requestId: string,
    agentId: string,
    tool: ToolName,
    args: Record<string, JsonValue>,
    onOutput: (chunk: string) => void = () => {},
  ): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      this.#pendingToolCalls.set(requestId, { resolve, reject, onOutput });
      this.#send({
        type: "gateway.run.tool",
        requestId,
        agentId,
        tool,
        arguments: args,
      });
    });
  }

  /** Send a prepare-workspace message. */
  prepareWorkspace(requestId: string, agentId: string): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      this.#pendingToolCalls.set(requestId, { resolve, reject, onOutput: () => {} });
      this.#send({ type: "gateway.prepare.workspace", requestId, agentId });
    });
  }

  /** Drop the current connection abruptly, as a network failure or a gateway restart would. */
  disconnect(): void {
    this.#socket?.terminate();
    this.#socket = undefined;
    this.#authenticated = false;
    this.#nodeId = undefined;
  }

  stopAgent(agentId: string): void {
    this.#send({ type: "gateway.stop.agent", requestId: randomBytes(8).toString("hex"), agentId });
  }

  async #handleMessage(text: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = NodeRequestSchema.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;

    if (msg.type === "node.authenticate") {
      // The fake gateway keeps no node registry: it trusts the signature iff the test's
      // onConnect callback says so, or when no callback was given.
      const ok = this.#options.onConnect ? await this.#options.onConnect(msg.nodeId, "") : true;
      if (!ok) {
        this.#send({
          type: "gateway.error",
          requestId: msg.requestId,
          code: "unknown_identity",
          message: "rejected",
        });
        return;
      }
      this.#nodeId = msg.nodeId;
      this.#authenticated = true;
      this.#authentications++;
      this.#send({ type: "gateway.authenticated", requestId: msg.requestId, nodeId: msg.nodeId });
      return;
    }

    if (msg.type === "node.pair") {
      const ok = this.#options.onConnect
        ? await this.#options.onConnect(msg.nodeId, msg.publicKey)
        : true;
      if (!ok) {
        this.#send({
          type: "gateway.error",
          requestId: msg.requestId,
          code: "pairing_rejected",
          message: "rejected",
        });
        return;
      }
      this.#nodeId = msg.nodeId;
      this.#authenticated = true;
      this.#authentications++;
      this.#send({ type: "gateway.paired", requestId: msg.requestId, nodeId: msg.nodeId });
      return;
    }

    if (msg.type === "node.ping") {
      this.#send({ type: "gateway.pong", requestId: msg.requestId });
      return;
    }

    if (msg.type === "node.tool.result") {
      const pending = this.#pendingToolCalls.get(msg.requestId);
      if (pending) {
        this.#pendingToolCalls.delete(msg.requestId);
        pending.resolve({ content: msg.content, isError: msg.isError });
      }
      return;
    }

    if (msg.type === "node.tool.output") {
      this.#pendingToolCalls.get(msg.requestId)?.onOutput(msg.chunk);
    }
  }

  #send(msg: GatewayMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(GatewayMessageSchema.parse(msg)));
    }
  }
}
