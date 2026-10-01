import { z } from "zod";

export const agentToolIdentitySchema = z.object({
  runId: z.string(),
  nodeId: z.string(),
  agentId: z.string(),
  toolCallId: z.string(),
});
export type AgentToolIdentity = z.infer<typeof agentToolIdentitySchema>;

export const currentAgentToolRunSchema = z.object({
  run_id: z.string(),
  agent_id: z.string(),
  node_id: z.string(),
  action_scope_id: z.string(),
  channel_id: z.string(),
  session_id: z.string(),
  input_end_seq: z.number(),
});
export type CurrentAgentToolRun = z.infer<typeof currentAgentToolRunSchema>;

export interface AgentToolContext extends AgentToolIdentity {
  run: CurrentAgentToolRun;
  /** Node I/O must wait until the current-run check and intent have committed. */
  committed: Promise<void>;
  /** Check again immediately before dispatch or inside a synchronous side-effect commit. */
  requireCurrentRun(): void;
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
