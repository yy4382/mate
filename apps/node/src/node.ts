import { systemClock, type Clock } from "@mate/clock";
import { connect } from "./connection.ts";
import { Executor } from "./executor.ts";
import { loadOrCreateNodeIdentity } from "./identity.ts";

const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 10_000;

export type NodeOptions = {
  controlPlaneUrl: string;
  dataDirectory: string;
  workspacesRoot: string;
  pairingToken?: string | undefined;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  clock?: Clock;
};

/** The gateway refused this node's identity or pairing token; retrying cannot help. */
export class NodeRejectedError extends Error {
  override readonly name = "NodeRejectedError";
}

/**
 * Run the node until `signal` aborts: connect to the gateway, and reconnect with backoff whenever the link is lost.
 * Rejects with `NodeRejectedError` when the gateway refuses who the node is. However it ends, every process group the
 * node started is killed first.
 */
export async function startNode(options: NodeOptions, signal: AbortSignal): Promise<void> {
  const clock = options.clock ?? systemClock;
  const url = webSocketUrl(options.controlPlaneUrl);
  const { identity, created } = loadOrCreateNodeIdentity(options.dataDirectory);
  let pairingToken = options.pairingToken;
  if (created && pairingToken === undefined) {
    throw new NodeRejectedError("A new node needs a pairing token");
  }
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 30_000;
  if (heartbeatTimeoutMs <= heartbeatIntervalMs) {
    throw new Error("heartbeatTimeoutMs must be greater than heartbeatIntervalMs");
  }

  const executor = new Executor(options.workspacesRoot, clock);
  try {
    let retryMs = INITIAL_RETRY_MS;
    while (!signal.aborted) {
      const end = await connect(
        {
          url,
          identity,
          pairingToken,
          heartbeatIntervalMs,
          heartbeatTimeoutMs,
          handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
        },
        executor,
        clock,
        signal,
      );
      if (end.kind === "rejected") throw new NodeRejectedError(end.reason);
      if (end.paired) {
        // Paired once means known from now on; a token is single-use, and a working link resets the backoff.
        pairingToken = undefined;
        retryMs = INITIAL_RETRY_MS;
      }
      await clock.sleep(retryMs, signal);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    }
  } finally {
    executor.shutdown();
  }
}

function webSocketUrl(controlPlaneUrl: string): string {
  const url = new URL(controlPlaneUrl);
  const protocols: Record<string, string> = {
    "http:": "ws:",
    "https:": "wss:",
    "ws:": "ws:",
    "wss:": "wss:",
  };
  const protocol = protocols[url.protocol];
  if (protocol === undefined) throw new Error("controlPlaneUrl must use http, https, ws, or wss");
  url.protocol = protocol;
  url.pathname = "/api/nodes/connect";
  return url.toString();
}
