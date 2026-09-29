import { z } from "zod";

export interface AgentToolIdentity {
  runId: string;
  nodeId: string;
  agentId: string;
  toolCallId: string;
}

export interface AgentToolContext extends AgentToolIdentity {
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
