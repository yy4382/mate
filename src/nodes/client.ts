import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { WebSocket } from "ws";
import { loadOrCreateNodeIdentity, type NodeIdentity } from "./identity.js";
import { NodeControlMessageSchema, NodeRequestSchema } from "./protocol.js";
import {
  handleAgentProvisionRequest,
  provisionLinuxAgent,
  type LinuxAgentIdentity,
} from "./agent-provisioner.js";
import { ensureModelWorkerIdentity } from "./model-identity.js";
import { makeAgentRunRequest, runAgentModel, type AgentRunPage } from "./agent-runner.js";
import type { ModelProcessIdentity } from "./model-process.js";
import type { AgentProvisionStage } from "./protocol.js";

const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 30_000;

export interface LinuxNodeOptions {
  controlPlaneUrl: string;
  dataDirectory: string;
  agentHomeRoot?: string;
  pairingToken?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
}

interface NodeTestDependencies {
  modelWorkerEntry?: string;
  provisionAgent?: (
    agentId: string,
    onProgress: (stage: AgentProvisionStage) => void,
  ) => Promise<LinuxAgentIdentity>;
}

class NodeAuthenticationError extends Error {}

export async function runLinuxNode(options: LinuxNodeOptions, signal: AbortSignal): Promise<void> {
  return runLinuxNodeInternal(options, signal, {});
}

/** Test-only entry seam; the production CLI does not read a worker path from configuration. */
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
  const modelWorkerIdentity =
    process.platform === "linux" ? ensureModelWorkerIdentity() : undefined;
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
        options.agentHomeRoot ?? "/var/lib/mate/agents",
        modelWorkerIdentity,
        dependencies,
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
}

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
  agentHomeRoot: string,
  modelWorkerIdentity: ModelProcessIdentity | undefined,
  testDependencies: NodeTestDependencies,
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
    const pendingRunContexts = new Map<
        string,
        { runId: string; resolve(page: AgentRunPage): void; reject(error: Error): void }
      >(),
      pendingRunJournals = new Map<
        string,
        { runId: string; resolve(accepted: boolean): void; reject(error: Error): void }
      >(),
      pendingRunTools = new Map<
        string,
        {
          runId: string;
          toolCallId: string;
          resolve(result: { ok: true; result: unknown } | { ok: false; error: string }): void;
          reject(error: Error): void;
        }
      >(),
      activeRuns = new Map<string, { agentId: string; controller: AbortController }>();

    const abortActiveRuns = (message: string) => {
      for (const { controller } of activeRuns.values()) controller.abort(message);
      activeRuns.clear();
      for (const pending of pendingRunContexts.values()) pending.reject(new Error(message));
      pendingRunContexts.clear();
      for (const pending of pendingRunJournals.values()) pending.reject(new Error(message));
      pendingRunJournals.clear();
      for (const pending of pendingRunTools.values()) pending.reject(new Error(message));
      pendingRunTools.clear();
    };

    const cleanup = () => {
      if (heartbeat) clearInterval(heartbeat);
      if (pingTimeout) clearTimeout(pingTimeout);
      if (forceTerminateTimeout) clearTimeout(forceTerminateTimeout);
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      abortActiveRuns("Node WebSocket connection ended");
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
      if (message.type === "control.agent.run.context") {
        const pending = pendingRunContexts.get(message.requestId);
        if (!pending || pending.runId !== message.runId) return;
        pendingRunContexts.delete(message.requestId);
        pending.resolve({ messages: message.messages, nextCursor: message.nextCursor });
        return;
      }
      if (message.type === "control.agent.run.journal_ack") {
        const pending = pendingRunJournals.get(message.requestId);
        if (!pending || pending.runId !== message.runId) return;
        pendingRunJournals.delete(message.requestId);
        pending.resolve(message.accepted);
        return;
      }
      if (message.type === "control.agent.run.tool_result") {
        const pending = pendingRunTools.get(message.requestId);
        if (
          !pending ||
          pending.runId !== message.runId ||
          pending.toolCallId !== message.toolCallId
        )
          return;
        pendingRunTools.delete(message.requestId);
        pending.resolve(
          message.ok ? { ok: true, result: message.result } : { ok: false, error: message.error },
        );
        return;
      }
      if (message.type === "control.agent.run.cancel") {
        if (!authenticated)
          throw new NodeAuthenticationError("控制面在节点身份验证前取消 Agent 运行。");
        const active = activeRuns.get(message.runId);
        if (active?.agentId === message.agentId) active.controller.abort(message.reason);
        return;
      }
      if (message.type === "control.agent.run") {
        if (!authenticated)
          throw new NodeAuthenticationError("控制面在节点身份验证前请求 Agent 运行。");
        const runId = message.runId,
          agentId = message.agentId;
        if (!modelWorkerIdentity && !testDependencies.modelWorkerEntry) {
          message.apiKey = "";
          sendRunResult(runId, agentId, false, "model_unavailable");
          return;
        }
        if (
          activeRuns.has(runId) ||
          [...activeRuns.values()].some((run) => run.agentId === agentId) ||
          activeRuns.size >= 2
        ) {
          message.apiKey = "";
          sendRunResult(runId, agentId, false, "worker_failed");
          return;
        }
        const controller = new AbortController();
        activeRuns.set(runId, { agentId, controller });
        void runAgentModel(
          message,
          {
            context: (cursor, runSignal) => requestAgentContext(runId, agentId, cursor, runSignal),
            journal: (text, runSignal) => requestAgentJournal(runId, agentId, text, runSignal),
            tool: (toolCallId, operation, input, runSignal) =>
              requestAgentTool(runId, agentId, toolCallId, operation, input, runSignal),
            result: (ok, code) => sendRunResult(runId, agentId, ok, code),
          },
          controller.signal,
          {
            ...(modelWorkerIdentity ? { identity: modelWorkerIdentity } : {}),
            ...(testDependencies.modelWorkerEntry
              ? { modelWorkerEntry: testDependencies.modelWorkerEntry }
              : {}),
          },
        ).finally(() => activeRuns.delete(runId));
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
            testDependencies.provisionAgent
              ? testDependencies.provisionAgent(agentId, onProgress)
              : provisionLinuxAgent({
                  agentId,
                  homeRoot: resolvePath(agentHomeRoot),
                  onProgress,
                }),
        ).catch(() => {
          // Provisioning failures are returned as bounded protocol results by its handler.
        });
      }
    };

    function requestAgentContext(
      runId: string,
      agentId: string,
      cursor: number,
      runSignal: AbortSignal,
    ): Promise<AgentRunPage> {
      const request = makeAgentRunRequest("node.agent.run.context", runId, agentId, {
        cursor,
        limit: 100,
      });
      const requestId = request.requestId;
      return new Promise((resolvePage, rejectPage) => {
        const onAbort = () => {
          pendingRunContexts.delete(requestId);
          rejectPage(new Error("Agent run was interrupted"));
        };
        pendingRunContexts.set(requestId, {
          runId,
          resolve: (page) => {
            runSignal.removeEventListener("abort", onAbort);
            resolvePage(page);
          },
          reject: (error) => {
            runSignal.removeEventListener("abort", onAbort);
            rejectPage(error);
          },
        });
        runSignal.addEventListener("abort", onAbort, { once: true });
        try {
          sendRequest(socket, request);
        } catch (error) {
          pendingRunContexts.delete(requestId);
          runSignal.removeEventListener("abort", onAbort);
          rejectPage(error instanceof Error ? error : new Error("Could not request Agent context"));
        }
      });
    }

    function requestAgentJournal(
      runId: string,
      agentId: string,
      text: string,
      runSignal: AbortSignal,
    ): Promise<boolean> {
      const request = makeAgentRunRequest("node.agent.run.journal", runId, agentId, { text });
      const requestId = request.requestId;
      return new Promise((resolveAccepted, rejectAccepted) => {
        const onAbort = () => {
          pendingRunJournals.delete(requestId);
          rejectAccepted(new Error("Agent run was interrupted"));
        };
        pendingRunJournals.set(requestId, {
          runId,
          resolve: (accepted) => {
            runSignal.removeEventListener("abort", onAbort);
            resolveAccepted(accepted);
          },
          reject: (error) => {
            runSignal.removeEventListener("abort", onAbort);
            rejectAccepted(error);
          },
        });
        runSignal.addEventListener("abort", onAbort, { once: true });
        try {
          sendRequest(socket, request);
        } catch (error) {
          pendingRunJournals.delete(requestId);
          runSignal.removeEventListener("abort", onAbort);
          rejectAccepted(
            error instanceof Error ? error : new Error("Could not journal Agent reply"),
          );
        }
      });
    }

    function requestAgentTool(
      runId: string,
      agentId: string,
      toolCallId: string,
      operation: string,
      input: Record<string, unknown>,
      runSignal: AbortSignal,
    ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
      const request = makeAgentRunRequest("node.agent.run.tool", runId, agentId, {
        toolCallId,
        operation,
        input,
      });
      const requestId = request.requestId;
      return new Promise((resolveResult, rejectResult) => {
        const onAbort = () => {
          pendingRunTools.delete(requestId);
          rejectResult(new Error("Agent run was interrupted"));
        };
        pendingRunTools.set(requestId, {
          runId,
          toolCallId,
          resolve: (result) => {
            runSignal.removeEventListener("abort", onAbort);
            resolveResult(result);
          },
          reject: (error) => {
            runSignal.removeEventListener("abort", onAbort);
            rejectResult(error);
          },
        });
        runSignal.addEventListener("abort", onAbort, { once: true });
        try {
          sendRequest(socket, request);
        } catch (error) {
          pendingRunTools.delete(requestId);
          runSignal.removeEventListener("abort", onAbort);
          rejectResult(error instanceof Error ? error : new Error("Could not call Agent tool"));
        }
      });
    }

    function sendRunResult(
      runId: string,
      agentId: string,
      ok: boolean,
      code?: "model_unavailable" | "model_failed" | "worker_failed" | "aborted",
    ): void {
      if (socket.readyState !== WebSocket.OPEN || !authenticated) return;
      try {
        sendRequest(
          socket,
          makeAgentRunRequest("node.agent.run.result", runId, agentId, {
            ok,
            ...(ok || !code ? {} : { code }),
          }),
        );
      } catch {
        // The control plane will recover the durable run after this connection closes.
      }
    }

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
