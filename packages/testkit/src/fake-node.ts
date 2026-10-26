import {
  GatewayMessageSchema,
  NodeRequestSchema,
  type GatewayBrowse,
  type GatewayRunTool,
  type NodeBrowseOutcome,
  type NodeRequest,
  type NodeSystem,
  type NodeAccess,
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
  /** Omitted for an older node that does not report system information. */
  system?: NodeSystem;
  workspaceVisits?: true;
  shellContext?: boolean;
  onRunTool?: (msg: GatewayRunTool) => Promise<{
    outputs: string[];
    result: ToolResult;
  }>;
  onPrepareWorkspace?: (agentId: string, access: NodeAccess) => Promise<void>;
  /** Called with the request ID of a call the gateway stopped. */
  onStopTool?: (requestId: string) => void;
  /** Answers a browse. Without it, the node never answers one. */
  onBrowse?: (msg: GatewayBrowse) => Promise<NodeBrowseOutcome>;
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
  #pongs = 0;
  #closed: Promise<void> = Promise.resolve();
  #onAuthenticated?: () => void;
  #onAuthError?: (err: Error) => void;

  constructor(options: FakeNodeOptions) {
    this.#options = options;
  }

  /**
   * Open a new connection and complete the challenge/authenticate handshake. Resolves when authenticated. Calling it
   * again opens a fresh connection, as a reconnecting node would.
   */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.#options.gatewayUrl);
      this.#ws = ws;
      this.#authenticated = false;
      this.#closed = new Promise((closed) => ws.once("close", () => closed()));
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
      const message = {
        type: "node.authenticate" as const,
        requestId: randomUUID(),
        nodeId: this.#options.nodeId,
        signature: sig,
        ...(this.#options.workspaceVisits === true ? { workspaceVisits: true } : {}),
        ...(this.#options.shellContext === false ? {} : { shellContext: true }),
      };
      const system = this.#options.system;
      this.#ws?.send(JSON.stringify(system === undefined ? message : { ...message, system }));
      return;
    }

    if (msg.type === "gateway.refused") {
      const challenge = this.#challenge;
      const { pairingToken, publicKey } = this.#options;
      if (
        msg.code === "unknown_identity" &&
        challenge !== undefined &&
        pairingToken !== undefined &&
        publicKey !== undefined
      ) {
        const message = {
          type: "node.pair" as const,
          requestId: randomUUID(),
          nodeId: this.#options.nodeId,
          publicKey,
          signature: this.#options.sign(challenge),
          pairingToken,
          ...(this.#options.workspaceVisits === true ? { workspaceVisits: true } : {}),
          ...(this.#options.shellContext === false ? {} : { shellContext: true }),
        };
        const system = this.#options.system;
        this.#ws?.send(JSON.stringify(system === undefined ? message : { ...message, system }));
        return;
      }
      this.#onAuthError?.(new Error(`Gateway refused: ${msg.code} — ${msg.message}`));
      return;
    }

    if (msg.type === "gateway.error") {
      this.#onAuthError?.(new Error(`Gateway error: ${msg.code} — ${msg.message}`));
      return;
    }

    if (msg.type === "gateway.authenticated" || msg.type === "gateway.paired") {
      this.#authenticated = true;
      this.#onAuthenticated?.();
      return;
    }

    if (msg.type === "gateway.pong") {
      this.#pongs++;
      return;
    }

    if (msg.type === "gateway.run.tool") {
      void this.#handleRunTool(msg);
      return;
    }

    if (msg.type === "gateway.stop.tool") {
      this.#options.onStopTool?.(msg.requestId);
      return;
    }

    if (msg.type === "gateway.prepare.workspace") {
      void this.#handlePrepareWorkspace(msg.requestId, msg.agentId, msg.access);
      return;
    }

    if (msg.type === "gateway.browse") {
      const outcome = await this.#options.onBrowse?.(msg);
      if (outcome !== undefined)
        this.send({ type: "node.browse.result", requestId: msg.requestId, outcome });
    }
  }

  async #handleRunTool(msg: GatewayRunTool): Promise<void> {
    const handler = this.#options.onRunTool;
    if (!handler) {
      this.send({
        type: "node.tool.result",
        requestId: msg.requestId,
        content: [{ type: "text", text: "(no handler)" }],
        isError: false,
      });
      return;
    }
    const { outputs, result } = await handler(msg);
    for (const chunk of outputs) {
      this.send({ type: "node.tool.output", requestId: msg.requestId, chunk });
    }
    this.send({
      type: "node.tool.result",
      requestId: msg.requestId,
      content: result.content,
      isError: result.isError,
    });
  }

  async #handlePrepareWorkspace(
    requestId: string,
    agentId: string,
    access: NodeAccess,
  ): Promise<void> {
    try {
      await this.#options.onPrepareWorkspace?.(agentId, access);
      this.send({
        type: "node.tool.result",
        requestId,
        content: [{ type: "text", text: "Workspace prepared." }],
        isError: false,
      });
    } catch (error) {
      this.send({
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

  /**
   * Send any node message on the current connection, such as a result for a call this connection never received.
   * Returns false when the connection is not open, so nothing was sent.
   */
  send(msg: NodeRequest): boolean {
    if (this.#ws?.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(JSON.stringify(NodeRequestSchema.parse(msg)));
    return true;
  }

  /** Resolves once the current connection has closed, whichever side closed it. */
  closed(): Promise<void> {
    return this.#closed;
  }

  ping(): void {
    this.send({ type: "node.ping", requestId: randomUUID() });
  }

  terminate(): void {
    this.#ws?.terminate();
  }

  close(): void {
    this.#ws?.close(1000, "test done");
  }

  /** How many pongs have arrived. The gateway reads a connection in order, so a pong means it read what came before. */
  get pongs(): number {
    return this.#pongs;
  }

  get isAuthenticated(): boolean {
    return this.#authenticated;
  }
}
