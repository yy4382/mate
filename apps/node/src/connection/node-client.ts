import { NodeControlMessageSchema, NodeRequestSchema } from "@mate/protocol";

import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { join, resolve as resolvePath } from "node:path";
import { WebSocket } from "ws";
import { loadOrCreateNodeIdentity, type NodeIdentity } from "./node-identity.js";
import {
  handleAgentProvisionRequest,
  prepareAgentWorkspace,
  readAgentWorkspaceIdentity,
  type AgentWorkspaceRunner,
} from "../provisioning/agent-workspace.js";

import { openNodeProcessOperations } from "../processes/operation-runtime.js";
import type { AgentProcessOperations } from "../processes/operation-ledger.js";
import {
  LinuxWorkspaceExecutor,
  type WorkspaceExecutionRequest,
} from "../files/workspace-executor.js";
import { sendWorkspaceOperationResult } from "../files/workspace-result.js";

const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;

export interface LinuxNodeOptions {
  controlPlaneUrl: string;
  dataDirectory: string;
  agentWorkspaceRoot?: string;
  pairingToken?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

/** Agent workspaces belong to the launching account, so they default inside its own node data directory. */
export function defaultAgentWorkspaceRoot(dataDirectory: string): string {
  return join(resolvePath(dataDirectory), "agents");
}

interface NodeTestDependencies {
  processOperations?: AgentProcessOperations;
  workspaceExecutor?: Pick<LinuxWorkspaceExecutor, "execute" | "status"> &
    Partial<Pick<LinuxWorkspaceExecutor, "receiptRevision">>;
  prepareAgentWorkspace?: AgentWorkspaceRunner;
}

class NodeAuthenticationError extends Error {}

export async function runLinuxNode(options: LinuxNodeOptions, signal: AbortSignal): Promise<void> {
  return runLinuxNodeInternal(options, signal, {});
}

/** Test-only entry seam; substitutes only local execution or provisioning, never the model loop. */
export async function runLinuxNodeWithTestDependencies(
  options: LinuxNodeOptions,
  signal: AbortSignal,
  dependencies: NodeTestDependencies,
): Promise<void> {
  return runLinuxNodeInternal(options, signal, dependencies);
}

async function runLinuxNodeInternal(
  options: LinuxNodeOptions,
  signal: AbortSignal,
  dependencies: NodeTestDependencies,
): Promise<void> {
  const socketUrl = toWebSocketUrl(options.controlPlaneUrl);
  const { identity, created } = loadOrCreateNodeIdentity(options.dataDirectory);
  const agentWorkspaceRoot =
    options.agentWorkspaceRoot ?? defaultAgentWorkspaceRoot(options.dataDirectory);
  let pairingToken = options.pairingToken;
  if (created && !pairingToken)
    throw new Error("A new Linux node requires MATE_NODE_PAIRING_TOKEN");
  if (pairingToken && (pairingToken.length < 32 || pairingToken.length > 256))
    throw new Error("MATE_NODE_PAIRING_TOKEN is not valid");
  const heartbeatIntervalMs = positiveIntegerOption(
    options.heartbeatIntervalMs,
    HEARTBEAT_INTERVAL_MS,
  );
  const heartbeatTimeoutMs = positiveIntegerOption(
    options.heartbeatTimeoutMs,
    HEARTBEAT_TIMEOUT_MS,
  );
  if (heartbeatTimeoutMs <= heartbeatIntervalMs)
    throw new Error("Node heartbeat timeout must be longer than its interval");

  const processStore = dependencies.processOperations
    ? undefined
    : openNodeProcessOperations(options.dataDirectory, agentWorkspaceRoot);
  const processOperations = dependencies.processOperations ?? processStore!.operations;
  try {
    const workspaceExecutor =
      dependencies.workspaceExecutor ??
      (process.platform === "linux"
        ? new LinuxWorkspaceExecutor(agentWorkspaceRoot, options.dataDirectory)
        : undefined);
    let retryMs = INITIAL_RETRY_MS;
    while (!signal.aborted) {
      try {
        const connected = await connectOnce(
          socketUrl,
          identity,
          () => pairingToken,
          () => {
            pairingToken = undefined;
          },
          heartbeatIntervalMs,
          heartbeatTimeoutMs,
          agentWorkspaceRoot,
          dependencies,
          processOperations,
          workspaceExecutor,
          signal,
        );
        if (signal.aborted) break;
        retryMs = INITIAL_RETRY_MS;
        if (connected) process.stderr.write("Node WebSocket disconnected; reconnecting.\n");
      } catch (error) {
        if (error instanceof NodeAuthenticationError) throw error;
        if (signal.aborted) break;
        process.stderr.write("Node WebSocket connection failed; retrying.\n");
      }

      if (!signal.aborted) await waitOrAbort(retryMs, signal);
      retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    }
  } finally {
    // A node that is going away must not leave work behind that nothing tracks any more: each
    // ordinary command is its own process group, so it survives the node that started it. The stop
    // is best effort and its report is written to the node's own output, because shutdown still has
    // to finish; the durable operation records keep the result reviewable afterwards.
    try {
      const { stopped, unconfirmed } = await processOperations.stopAllAgents();
      if (stopped.length > 0 || unconfirmed.length > 0)
        process.stderr.write(nodeCommandStopReport(stopped.length, unconfirmed.length));
    } catch {
      process.stderr.write(nodeCommandStopReportUnavailable);
    }
    processStore?.close();
  }
}

/**
 * What the node tells its own log about the commands it was running when it stopped: how many it
 * ended, and how many it could not confirm ended. Operation receipts retain the outcome for
 * reconnection and restart; this output also makes an uncertain shutdown visible to the owner.
 */
export function nodeCommandStopReport(stopped: number, unconfirmed: number): string {
  return (
    `Node stopped ${stopped} running command(s)` +
    (unconfirmed > 0 ? `; ${unconfirmed} could not be confirmed stopped.\n` : ".\n")
  );
}

/** The node could not even attempt to end its commands, so none of them is accounted for. */
export const nodeCommandStopReportUnavailable =
  "Node could not stop its tracked commands while shutting down.\n";

export function toWebSocketUrl(controlPlaneUrl: string): string {
  let url: URL;
  try {
    url = new URL(controlPlaneUrl);
  } catch {
    throw new Error("MATE_CONTROL_PLANE_URL must be an absolute HTTP or HTTPS URL");
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error("MATE_CONTROL_PLANE_URL must not contain credentials, a query, or a fragment");
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new Error("MATE_CONTROL_PLANE_URL must use HTTP, HTTPS, WS, or WSS");
  url.pathname = "/api/nodes/connect";
  return url.toString();
}

function connectOnce(
  url: string,
  identity: NodeIdentity,
  getPairingToken: () => string | undefined,
  clearPairingToken: () => void,
  heartbeatIntervalMs: number,
  heartbeatTimeoutMs: number,
  agentWorkspaceRoot: string,
  testDependencies: NodeTestDependencies,
  processOperations: AgentProcessOperations,
  workspaceExecutor: NodeTestDependencies["workspaceExecutor"],
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  const socket = new WebSocket(url, { perMessageDeflate: false });

  return new Promise<boolean>((resolveConnection, rejectConnection) => {
    let settled = false,
      authenticated = false,
      challenge: string | undefined,
      authenticateRequestId: string | undefined,
      pairRequestId: string | undefined,
      heartbeat: ReturnType<typeof setInterval> | undefined,
      pingTimeout: ReturnType<typeof setTimeout> | undefined,
      forceTerminateTimeout: ReturnType<typeof setTimeout> | undefined,
      pendingPing: string | undefined,
      timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (heartbeat) clearInterval(heartbeat);
      if (pingTimeout) clearTimeout(pingTimeout);
      if (forceTerminateTimeout) clearTimeout(forceTerminateTimeout);
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      if (socket.readyState === WebSocket.CLOSED) {
        socket.removeEventListener("error", onError);
      } else {
        // ws.close() while CONNECTING emits an asynchronous error before close.
        // Keep the listener through that terminal event after timeout or abort.
        socket.addEventListener("close", () => socket.removeEventListener("error", onError), {
          once: true,
        });
      }
    };
    const resolve = (connected: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveConnection(connected);
    };
    const reject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.close(4008, "node protocol rejected");
      rejectConnection(error);
    };
    const sendPing = () => {
      if (!authenticated || socket.readyState !== WebSocket.OPEN || pendingPing) return;
      const requestId = randomUUID();
      pendingPing = requestId;
      pingTimeout = setTimeout(() => {
        if (pendingPing !== requestId) return;
        pendingPing = undefined;
        if (socket.readyState === WebSocket.CLOSED) return resolve(true);
        if (socket.readyState === WebSocket.OPEN)
          socket.close(4000, "heartbeat acknowledgement timed out");
        forceTerminateTimeout = setTimeout(() => {
          if (settled) return;
          socket.terminate();
          resolve(true);
        }, 25);
      }, heartbeatTimeoutMs);
      try {
        sendRequest(socket, { type: "node.ping", requestId, sentAt: Date.now() });
      } catch {
        socket.terminate();
        resolve(true);
      }
    };
    const authenticate = (nonce: string) => {
      authenticateRequestId = randomUUID();
      sendRequest(socket, {
        type: "node.authenticate",
        requestId: authenticateRequestId,
        nodeId: identity.id,
        signature: signChallenge(identity, nonce),
      });
    };
    const pair = (nonce: string) => {
      const pairingToken = getPairingToken();
      if (!pairingToken)
        return reject(new NodeAuthenticationError("此节点身份尚未配对，且没有可用的配对令牌。"));
      pairRequestId = randomUUID();
      sendRequest(socket, {
        type: "node.pair",
        requestId: pairRequestId,
        nodeId: identity.id,
        pairingToken,
        publicKey: identity.publicKey,
        signature: signChallenge(identity, nonce),
      });
    };
    const onAbort = () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.close(1000, "node shutting down");
      resolve(false);
    };
    const onError = () => {
      // Browsers and Node expose no useful WebSocket error detail; the close event drives retry.
    };
    const onClose = () => {
      if (authenticated) resolve(true);
      else reject(new Error("Node WebSocket closed before identity was verified"));
    };
    const onMessage = (event: WebSocket.MessageEvent) => {
      void handleMessage(event.data).catch((error: unknown) => {
        reject(error instanceof Error ? error : new Error("Invalid control-plane response"));
      });
    };
    const handleMessage = async (data: unknown): Promise<void> => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(await messageText(data));
      } catch {
        throw new NodeAuthenticationError("控制面发来了无效的节点协议消息。");
      }
      const parsed = NodeControlMessageSchema.safeParse(decoded);
      if (!parsed.success) throw new NodeAuthenticationError("控制面发来了无效的节点协议消息。");
      const message = parsed.data;
      if (message.type === "control.challenge") {
        if (challenge) throw new NodeAuthenticationError("控制面重复发送了节点身份质询。");
        challenge = message.nonce;
        authenticate(message.nonce);
        return;
      }
      if (message.type === "control.error") {
        if (message.code === "unknown_identity" && message.requestId === authenticateRequestId) {
          pair(challenge!);
          return;
        }
        if (message.code === "unknown_identity" || message.code === "pairing_rejected")
          throw new NodeAuthenticationError("配对令牌无效、已过期或已使用。");
        if (message.code === "invalid_identity")
          throw new NodeAuthenticationError("控制面拒绝了此节点身份。");
        throw new NodeAuthenticationError("控制面拒绝了节点协议请求。");
      }
      if (message.type === "control.paired") {
        if (message.requestId !== pairRequestId || message.nodeId !== identity.id)
          throw new NodeAuthenticationError("控制面返回了不匹配的节点配对确认。");
        if (timeout) clearTimeout(timeout);
        timeout = undefined;
        clearPairingToken();
        authenticated = true;
        process.stdout.write(`MATE_NODE_PAIRED ${identity.id}\n`);
        sendPing();
        heartbeat = setInterval(sendPing, heartbeatIntervalMs);
        return;
      }
      if (message.type === "control.authenticated") {
        if (message.requestId !== authenticateRequestId || message.nodeId !== identity.id)
          throw new NodeAuthenticationError("控制面返回了不匹配的节点身份确认。");
        if (timeout) clearTimeout(timeout);
        timeout = undefined;
        authenticated = true;
        process.stdout.write(`MATE_NODE_CONNECTED ${identity.id}\n`);
        sendPing();
        heartbeat = setInterval(sendPing, heartbeatIntervalMs);
        return;
      }
      if (message.type === "control.pong" && pendingPing === message.requestId) {
        pendingPing = undefined;
        if (pingTimeout) clearTimeout(pingTimeout);
        pingTimeout = undefined;
        process.stdout.write(`MATE_NODE_HEARTBEAT_ACK ${message.requestId}\n`);
        return;
      }
      if (message.type === "control.agent.activate") {
        if (!authenticated) throw new NodeAuthenticationError("控制面在节点身份验证前复启 Agent。");
        processOperations.allowAgent(message.agentId);
        return;
      }
      if (message.type === "control.process.operation") {
        if (!authenticated)
          throw new NodeAuthenticationError("控制面在节点身份验证前请求普通操作。");
        const { requestId, operationId, agentId, operation } = message;
        // Do not bind execution to this WebSocket's lifetime. Node receipts let the control plane
        // reconcile the same operation after a reconnect; the command's own result is recorded
        // from what the ordinary child process did.
        void processOperations
          .execute(agentId, operationId, operation)
          .then((result) => {
            if (socket.readyState !== WebSocket.OPEN || !authenticated) return;
            sendRequest(socket, {
              type: "node.process.operation.result",
              requestId,
              operationId,
              agentId,
              state: result.state === "started" ? "unknown" : result.state,
              receipt: result.receipt,
              revision: result.revision,
            });
          })
          .catch(() => {
            if (socket.readyState !== WebSocket.OPEN || !authenticated) return;
            sendRequest(socket, {
              type: "node.process.operation.result",
              requestId,
              operationId,
              agentId,
              state: "unknown",
              receipt: { reason: "node_operation_result_unavailable" },
            });
          });
        return;
      }
      if (message.type === "control.workspace.operation") {
        if (!authenticated)
          throw new NodeAuthenticationError("控制面在节点身份验证前请求工作区操作。");
        const { requestId, operationId, agentId, mode, operation } = message,
          request: WorkspaceExecutionRequest = { operationId, agentId, mode, operation };
        if (!workspaceExecutor) {
          sendRequest(socket, {
            type: "node.workspace.operation.result",
            requestId,
            operationId,
            agentId,
            ok: false,
            error: "Linux workspace executor is unavailable",
          });
          return;
        }
        void workspaceExecutor
          .execute(request)
          .then(
            (result) => {
              if (socket.readyState !== WebSocket.OPEN || !authenticated) return;
              const revision = workspaceExecutor.receiptRevision?.(agentId, operationId);
              sendWorkspaceOperationResult(
                (response) => sendRequest(socket, response),
                {
                  requestId,
                  operationId,
                  agentId,
                  ...(revision !== undefined ? { revision } : {}),
                },
                result,
              );
            },
            () => {
              if (socket.readyState !== WebSocket.OPEN || !authenticated) return;
              sendRequest(socket, {
                type: "node.workspace.operation.result",
                requestId,
                operationId,
                agentId,
                ok: false,
                error: "Linux workspace operation could not be confirmed",
              });
            },
          )
          .catch(() => undefined);
        return;
      }
      if (message.type === "control.process.reconcile") {
        if (!authenticated)
          throw new NodeAuthenticationError("控制面在节点身份验证前请求操作对账。");
        sendRequest(socket, {
          type: "node.process.reconcile.result",
          requestId: message.requestId,
          receipts: message.operations.flatMap(({ agentId, operationId, requestHash }) => {
            try {
              const result = processOperations.status(agentId, operationId, requestHash);
              if (!result || result.state === "started") return [];
              const receipt = {
                operationId,
                agentId,
                state: result.state,
                receipt: result.receipt,
                revision: result.revision,
              };
              return NodeRequestSchema.safeParse({
                type: "node.process.reconcile.result",
                requestId: message.requestId,
                receipts: [receipt],
              }).success
                ? [receipt]
                : [];
            } catch {
              return [];
            }
          }),
        });
        return;
      }
      if (message.type === "control.workspace.reconcile") {
        if (!authenticated)
          throw new NodeAuthenticationError("控制面在节点身份验证前请求文件操作对账。");
        sendRequest(socket, {
          type: "node.workspace.reconcile.result",
          requestId: message.requestId,
          receipts: message.operations.flatMap(({ agentId, operationId, requestHash }) => {
            try {
              const result = workspaceExecutor?.status(agentId, operationId, requestHash);
              const revision = workspaceExecutor?.receiptRevision?.(agentId, operationId);
              if (!result) return [];
              const receipt = { operationId, agentId, result: { ...result, revision } };
              return NodeRequestSchema.safeParse({
                type: "node.workspace.reconcile.result",
                requestId: message.requestId,
                receipts: [receipt],
              }).success
                ? [receipt]
                : [];
            } catch {
              return [];
            }
          }),
        });
        return;
      }
      if (message.type === "control.agent.provision") {
        if (!authenticated)
          throw new NodeAuthenticationError("控制面在节点身份验证前请求创建 Agent。");
        void handleAgentProvisionRequest(
          message,
          (request) => {
            if (socket.readyState === WebSocket.OPEN) sendRequest(socket, request);
          },
          (agentId, onProgress) =>
            message.verifyOnly
              ? Promise.resolve(
                  readAgentWorkspaceIdentity(agentId, resolvePath(agentWorkspaceRoot)),
                )
              : testDependencies.prepareAgentWorkspace
                ? testDependencies.prepareAgentWorkspace(agentId, onProgress)
                : prepareAgentWorkspace({
                    agentId,
                    workspaceRoot: resolvePath(agentWorkspaceRoot),
                    onProgress,
                  }),
        ).catch(() => {
          // Provisioning failures are returned as bounded protocol results by its handler.
        });
      }
    };

    signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError);
    timeout = setTimeout(
      () => reject(new Error("Node WebSocket handshake timed out")),
      HANDSHAKE_TIMEOUT_MS,
    );
  });
}

function sendRequest(socket: WebSocket, request: unknown): void {
  socket.send(JSON.stringify(NodeRequestSchema.parse(request)));
}

function signChallenge(identity: NodeIdentity, nonce: string): string {
  return sign(null, Buffer.from(nonce, "utf8"), createPrivateKey(identity.privateKey)).toString(
    "base64url",
  );
}

async function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data))
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  throw new Error("Only text control-plane messages are supported");
}

function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveWait) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolveWait();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolveWait();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function positiveIntegerOption(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1)
    throw new Error("Node heartbeat interval and timeout must be positive integers");
  return result;
}
