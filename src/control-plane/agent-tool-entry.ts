import { z } from "zod";

export interface AgentToolIdentity {
  runId: string;
  nodeId: string;
  agentId: string;
  toolCallId: string;
}

export interface CurrentAgentToolRun {
  run_id: string;
  agent_id: string;
  node_id: string;
  action_scope_id: string;
  channel_id: string;
  session_id: string;
  input_end_seq: number;
}

export interface AgentToolContext extends AgentToolIdentity {
  run: CurrentAgentToolRun;
  /** Node I/O must wait until the current-run check and intent have committed. */
  committed: Promise<void>;
  request: { operation: string; input: unknown };
}

export interface AgentToolEntry {
  description: string;
  schema: z.ZodType;
  invoke(identity: AgentToolContext, input: unknown): unknown;
  unexpectedError: string;
}

/** Capture schema and handler together before heterogeneous entries enter the registry. */
export function defineAgentTool<S extends z.ZodType>(
  definition: { description: string; schema: S },
  handler: (identity: AgentToolContext, input: z.output<S>) => unknown,
  unexpectedError = "Agent tool request was refused",
) {
  return {
    ...definition,
    unexpectedError,
    invoke(identity: AgentToolContext, input: unknown): unknown {
      return handler(identity, definition.schema.parse(input));
    },
  };
}
