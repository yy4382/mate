import { randomUUID } from "node:crypto";
import { hostname, release } from "node:os";
import { WebSocket } from "ws";
import type { Clock } from "@mate/clock";
import {
  GatewayMessageSchema,
  NodeRequestSchema,
  type GatewayMessage,
  type GatewayRunTool,
  type NodeRequest,
  type NodeSystem,
} from "@mate/node-protocol";
import type { Executor } from "./executor.ts";
import { signChallenge, type NodeIdentity } from "./identity.ts";

declare const __MATE_NODE_VERSION__: string;

function nodeSystem(): NodeSystem {
  return {
    platform: process.platform,
    arch: process.arch,
    hostname: hostname(),
    osRelease: release(),
    version: typeof __MATE_NODE_VERSION__ === "undefined" ? "dev" : __MATE_NODE_VERSION__,
  };
}

export type ConnectionOptions = {
  url: string;
  identity: NodeIdentity;
  /** The pairing token while the node has not paired yet; used only after the gateway says it does not know us. */
  pairingToken: string | undefined;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  handshakeTimeoutMs: number;
  /** Called once, when the gateway has accepted this node on this connection. */
  onHandshake: () => void;
};

/**
 * How one connection ended: the gateway refused who we are (`gateway.refused`), or the link went away or the gateway
 * ended it over a protocol error (`gateway.error`), both worth retrying.
 */
export type ConnectionEnd =
  { kind: "rejected"; reason: string } | { kind: "lost"; paired: boolean };

/**
 * One WebSocket connection to the gateway, from handshake to close. Tool calls it receives run on the executor; when
 * the connection ends, every call still running on it is stopped, because nobody waits for its result any more.
 */
export function connect(
  options: ConnectionOptions,
  executor: Executor,
  clock: Clock,
  shutdown: AbortSignal,
): Promise<ConnectionEnd> {
  return new Promise((resolve) => {
    const socket = new WebSocket(options.url);
    // Ends with the connection: stops its timers and every tool call it started.
    const lifetime = new AbortController();
    // Running calls by the request ID the gateway gave each; aborting one stops it.
    const calls = new Map<string, AbortController>();
    let authRequestId: string | undefined;
    let nonce = "";
    let authenticated = false;
    let paired = false;
    let lastPong = clock.now();
    let end: ConnectionEnd | undefined;

    const finish = (ending: ConnectionEnd) => {
      end ??= ending;
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      shutdown.removeEventListener("abort", onShutdown);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
      resolve(end);
    };
    const onShutdown = () => finish({ kind: "lost", paired });
    shutdown.addEventListener("abort", onShutdown, { once: true });
    lifetime.signal.addEventListener("abort", () => {
      for (const stop of calls.values()) stop.abort();
      calls.clear();
    });

    const send = (message: NodeRequest) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(NodeRequestSchema.parse(message)));
      }
    };

    void clock.sleep(options.handshakeTimeoutMs, lifetime.signal).then(() => {
      if (!authenticated) finish({ kind: "lost", paired });
    });

    const heartbeat = async () => {
      while (!lifetime.signal.aborted) {
        if (clock.now() - lastPong > options.heartbeatTimeoutMs) {
          finish({ kind: "lost", paired });
          return;
        }
        send({ type: "node.ping", requestId: randomUUID() });
        await clock.sleep(options.heartbeatIntervalMs, lifetime.signal);
      }
    };

    const runTool = async (message: GatewayRunTool) => {
      const stop = new AbortController();
      calls.set(message.requestId, stop);
      const result = await executor.run(
        message,
        (chunk) => send({ type: "node.tool.output", requestId: message.requestId, chunk }),
        stop.signal,
      );
      calls.delete(message.requestId);
      send({ type: "node.tool.result", requestId: message.requestId, ...result });
    };

    const dispatch = (message: GatewayMessage) => {
      switch (message.type) {
        case "gateway.challenge":
          nonce = message.nonce;
          authRequestId = randomUUID();
          send({
            type: "node.authenticate",
            requestId: authRequestId,
            nodeId: options.identity.id,
            signature: signChallenge(options.identity, nonce),
            system: nodeSystem(),
            workspaceVisits: true,
          });
          return;
        case "gateway.refused":
          if (message.code === "unknown_identity" && message.requestId === authRequestId) {
            if (options.pairingToken === undefined) {
              finish({ kind: "rejected", reason: "the gateway does not know this node" });
              return;
            }
            send({
              type: "node.pair",
              requestId: randomUUID(),
              nodeId: options.identity.id,
              publicKey: options.identity.publicKey,
              signature: signChallenge(options.identity, nonce),
              pairingToken: options.pairingToken,
              system: nodeSystem(),
              workspaceVisits: true,
            });
            return;
          }
          finish({ kind: "rejected", reason: `${message.code}: ${message.message}` });
          return;
        case "gateway.error":
          finish({ kind: "lost", paired });
          return;
        case "gateway.paired":
        case "gateway.authenticated":
          paired = true;
          authenticated = true;
          lastPong = clock.now();
          options.onHandshake();
          void heartbeat();
          return;
        case "gateway.pong":
          lastPong = clock.now();
          return;
        case "gateway.run.tool":
          void runTool(message);
          return;
        case "gateway.stop.tool":
          calls.get(message.requestId)?.abort();
          calls.delete(message.requestId);
          return;
        case "gateway.prepare.workspace":
          send({
            type: "node.tool.result",
            requestId: message.requestId,
            ...executor.prepareWorkspace(message.agentId, message.access),
          });
          return;
        case "gateway.browse":
          void executor
            .browse(message)
            .then((outcome) =>
              send({ type: "node.browse.result", requestId: message.requestId, outcome }),
            );
          return;
      }
    };

    socket.on("message", (data) => {
      let parsed: ReturnType<typeof GatewayMessageSchema.safeParse>;
      try {
        parsed = GatewayMessageSchema.safeParse(JSON.parse(String(data)));
      } catch {
        parsed = GatewayMessageSchema.safeParse(undefined);
      }
      if (parsed.success) dispatch(parsed.data);
      else finish({ kind: "lost", paired });
    });
    socket.on("close", () => finish({ kind: "lost", paired }));
    // An error is always followed by close, which decides what happens next.
    socket.on("error", () => {});
  });
}
