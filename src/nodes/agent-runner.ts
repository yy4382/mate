import { randomUUID } from "node:crypto";
import type { NodeControlMessage, NodeRequest } from "./protocol.js";
import { NodeRequestSchema } from "./protocol.js";
import { ModelRunFailure, startModelProcess, type ModelProcessSession } from "./model-process.js";
import type { SessionCommit } from "./session-record.js";
import type { ModelContextMessage } from "./model-worker.js";

type AgentRunMessage = Extract<NodeControlMessage, { type: "control.agent.run" }>;

export interface AgentRunPage {
  messages: ModelContextMessage[];
  nextCursor: number | null;
}

export interface AgentRunTransport {
  /** Cursor addresses a message position in the ordered context supplied to this run. */
  context(cursor: number, signal: AbortSignal): Promise<AgentRunPage>;
  /**
   * Record one complete Pi message or run configuration in the Agent's own session record. Resolves false when the
   * control plane refuses the entry; this transport never publishes to a conversation.
   */
  transcript(entry: SessionCommit, signal: AbortSignal): Promise<boolean>;
  tool(
    toolCallId: string,
    operation: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
  result(
    ok: boolean,
    code?:
      | "model_unavailable"
      | "model_failed"
      | "worker_failed"
      | "credentials_invalid"
      | "context_failed"
      | "aborted",
    reason?: string,
  ): void;
}

export interface AgentRunOptions {
  /** Test-only seam; production node configuration never accepts a worker entry path. */
  modelWorkerEntry?: string;
  /** Receives this run's model process so the node can hand it mid-run notices. */
  onWorker?(worker: ModelProcessSession): void;
}

/** Keep one Pi session per Agent and record each complete Pi message in its session record. */
export async function runAgentModel(
  request: AgentRunMessage,
  transport: AgentRunTransport,
  connectionSignal: AbortSignal,
  dependencies: AgentRunOptions = {},
): Promise<void> {
  let apiKey = request.apiKey;
  const provider = request.provider,
    modelId = request.modelId,
    runId = request.runId,
    sessionId = request.sessionId,
    sourceChannel = { channelId: request.channelId, visibility: request.channelVisibility },
    prompt = request.prompt;
  // Do not retain the protocol object, which otherwise keeps the credential alive during paging.
  request.apiKey = "";

  let worker: ModelProcessSession | undefined;
  try {
    worker = startModelProcess({
      provider,
      modelId,
      apiKey,
      ...(dependencies.modelWorkerEntry ? { entry: dependencies.modelWorkerEntry } : {}),
      onTranscript: (text) => transport.transcript(text, connectionSignal),
      onTool: (toolCallId, operation, input) =>
        transport.tool(toolCallId, operation, input, connectionSignal),
      signal: connectionSignal,
    });
    apiKey = "";
    dependencies.onWorker?.(worker);
    const messages: ModelContextMessage[] = [];
    let cursor = 0;
    while (true) {
      const page = await transport.context(cursor, connectionSignal);
      messages.push(...page.messages);
      if (page.nextCursor === null) break;
      if (page.nextCursor <= cursor) throw new Error("Invalid Agent session page");
      cursor = page.nextCursor;
    }
    if (!messages.length) throw new Error("Agent session context is empty");
    await worker.run({
      runId,
      agentId: request.agentId,
      sessionId,
      actionScopeId: request.actionScopeId,
      messages,
      sourceChannel,
      prompt,
    });
    if (!connectionSignal.aborted) transport.result(true);
  } catch (error) {
    if (!connectionSignal.aborted)
      transport.result(
        false,
        error instanceof ModelRunFailure ? error.code : "model_failed",
        error instanceof ModelRunFailure ? error.reason : undefined,
      );
  } finally {
    apiKey = "";
    worker?.close();
  }
}

/** Build bounded node requests shared by the WebSocket client and its process tests. */
export function makeAgentRunRequest(
  type:
    | "node.agent.run.context"
    | "node.agent.run.transcript"
    | "node.agent.run.tool"
    | "node.agent.run.result",
  runId: string,
  agentId: string,
  fields: Record<string, unknown>,
): NodeRequest {
  return NodeRequestSchema.parse({ type, requestId: randomUUID(), runId, agentId, ...fields });
}
