import {
  GatewayMessageSchema,
  NodeRequestSchema,
  type GatewayRunTool,
  type NodeRequest,
  type ToolResult,
} from "@mate/node-protocol";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

export interface FakeNodeOptions {
  gatewayUrl: string;
  nodeId: string;
  /**
   * Signs the nonce for authenticate/pair. In tests, pass signChallenge from @mate/node.
   * Accepts the nonce string and returns a base64url signature.
   */
  sign: (nonce: string) => string;
  publicKey?: string | undefined;
  pairingToken?: string | undefined;
  onRunTool?: (msg: GatewayRunTool) => Promise<{
    outputs: string[];
    result: ToolResult;
  }>;
  onPrepareWorkspace?: (agentId: string) => Promise<void>;
  onStopAgent?: (agentId: string) => void;
}

/**
 * A fake node WebSocket client that speaks the node-protocol.
 * Used in gateway tests to exercise the full protocol without running a real node process.
 */
export class FakeNode {
  readonly #options: FakeNodeOptions;
  #ws: WebSocket | undefined;
  #challenge: string | undefined;
  #authenticated = false;
  #onAuthenticated?: () => void;
  #onAuthError?: (err: Error) => void;

  constructor(options: FakeNodeOptions) {
    this.#options = options;
  }

  /** Connect and complete the challenge/authenticate handshake. Resolves when authenticated. */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.#options.gatewayUrl);
      this.#ws = ws;
      this.#onAuthenticated = resolve;
      this.#onAuthError = reject;

      ws.on("message", (data) => {
        void this.#handleMessage(String(data)).catch((err) => {
          this.#onAuthError?.(err instanceof Error ? err : new Error(String(err)));
        });
      });

      ws.on("error", (err) => {
        reject(err);
      });

      ws.on("close", () => {
        if (!this.#authenticated) {
          reject(new Error("WebSocket closed before authentication"));
        }
      });
    });
  }

  async #handleMessage(text: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = GatewayMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;

    if (msg.type === "gateway.challenge") {
      this.#challenge = msg.nonce;
      const sig = this.#options.sign(msg.nonce);
      this.#send({
        type: "node.authenticate",
        requestId: randomUUID(),
        nodeId: this.#options.nodeId,
        signature: sig,
      });
      return;
    }

    if (msg.type === "gateway.error") {
      if (
        msg.code === "unknown_identity" &&
        this.#options.pairingToken &&
        this.#options.publicKey
      ) {
        const sig = this.#options.sign(this.#challenge!);
        this.#send({
          type: "node.pair",
          requestId: randomUUID(),
          nodeId: this.#options.nodeId,
          publicKey: this.#options.publicKey,
          signature: sig,
          pairingToken: this.#options.pairingToken,
        });
        return;
      }
      this.#onAuthError?.(new Error(`Gateway error: ${msg.code} — ${msg.message}`));
      return;
    }

    if (msg.type === "gateway.authenticated" || msg.type === "gateway.paired") {
      this.#authenticated = true;
      this.#onAuthenticated?.();
      return;
    }

    if (msg.type === "gateway.pong") return;

    if (msg.type === "gateway.run.tool") {
      void this.#handleRunTool(msg);
      return;
    }

    if (msg.type === "gateway.stop.agent") {
      this.#options.onStopAgent?.(msg.agentId);
      return;
    }

    if (msg.type === "gateway.prepare.workspace") {
      void this.#handlePrepareWorkspace(msg.requestId, msg.agentId);
      return;
    }
  }

  async #handleRunTool(msg: GatewayRunTool): Promise<void> {
    const handler = this.#options.onRunTool;
    if (!handler) {
      this.#send({
        type: "node.tool.result",
        requestId: msg.requestId,
        content: [{ type: "text", text: "(no handler)" }],
        isError: false,
      });
      return;
    }
    const { outputs, result } = await handler(msg);
    for (const chunk of outputs) {
      this.#send({ type: "node.tool.output", requestId: msg.requestId, chunk });
    }
    this.#send({
      type: "node.tool.result",
      requestId: msg.requestId,
      content: result.content,
      isError: result.isError,
    });
  }

  async #handlePrepareWorkspace(requestId: string, agentId: string): Promise<void> {
    try {
      await this.#options.onPrepareWorkspace?.(agentId);
      this.#send({
        type: "node.tool.result",
        requestId,
        content: [{ type: "text", text: "Workspace prepared." }],
        isError: false,
      });
    } catch (error) {
      this.#send({
        type: "node.tool.result",
        requestId,
        content: [
          {
            type: "text",
            text: `Prepare workspace failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      });
    }
  }

  #send(msg: NodeRequest): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(NodeRequestSchema.parse(msg)));
    }
  }

  ping(): void {
    this.#send({ type: "node.ping", requestId: randomUUID() });
  }

  terminate(): void {
    this.#ws?.terminate();
  }

  close(): void {
    this.#ws?.close(1000, "test done");
  }

  get isAuthenticated(): boolean {
    return this.#authenticated;
  }
}
