import { randomUUID } from "node:crypto";
import type { NodeControlMessage, NodeRequest } from "./protocol.js";
import { NodeRequestSchema } from "./protocol.js";
import {
  startModelProcess,
  type ModelProcessIdentity,
  type ModelProcessSession,
} from "./model-process.js";
import type { ModelContextMessage } from "./model-worker.js";

type AgentRunMessage = Extract<NodeControlMessage, { type: "control.agent.run" }>;

export interface AgentRunPage {
  messages: ModelContextMessage[];
  nextAfter: number | null;
}

export interface AgentRunTransport {
  context(after: number, signal: AbortSignal): Promise<AgentRunPage>;
  journal(text: string, signal: AbortSignal): Promise<boolean>;
  result(
    ok: boolean,
    code?: "model_unavailable" | "model_failed" | "worker_failed" | "aborted",
  ): void;
}

export interface AgentRunTestDependencies {
  /** Test-only seam; production node configuration never accepts a worker entry path. */
  modelWorkerEntry?: string;
  /** Test-only identity override for process-boundary checks. */
  identity?: ModelProcessIdentity;
}

/** Keep one Pi session per Agent and bind each completed assistant turn to its owner DM. */
export async function runAgentModel(
  request: AgentRunMessage,
  transport: AgentRunTransport,
  connectionSignal: AbortSignal,
  dependencies: AgentRunTestDependencies = {},
): Promise<void> {
  let apiKey = request.apiKey;
  const provider = request.provider,
    modelId = request.modelId,
    runId = request.runId,
    sessionId = request.sessionId,
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
      ...(dependencies.identity ? { identity: dependencies.identity } : {}),
      onJournal: (text) => transport.journal(text, connectionSignal),
      signal: connectionSignal,
    });
    apiKey = "";
    const messages: ModelContextMessage[] = [];
    let after = 0;
    while (true) {
      const page = await transport.context(after, connectionSignal);
      messages.push(...page.messages);
      if (page.nextAfter === null) break;
      if (page.nextAfter <= after) throw new Error("Invalid Agent session page");
      after = page.nextAfter;
    }
    if (!messages.length) throw new Error("Agent session context is empty");
    await worker.run({ runId, sessionId, messages, prompt });
    if (!connectionSignal.aborted) transport.result(true);
  } catch {
    if (!connectionSignal.aborted) transport.result(false, "model_failed");
  } finally {
    apiKey = "";
    worker?.close();
  }
}

/** Build bounded node requests shared by the WebSocket client and its process tests. */
export function makeAgentRunRequest(
  type: "node.agent.run.context" | "node.agent.run.journal" | "node.agent.run.result",
  runId: string,
  agentId: string,
  fields: Record<string, unknown>,
): NodeRequest {
  return NodeRequestSchema.parse({ type, requestId: randomUUID(), runId, agentId, ...fields });
}
