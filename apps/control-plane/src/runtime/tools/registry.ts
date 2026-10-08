import { AgentHistory } from "../../agent-history.js";
import { currentAgentToolRunSchema } from "./entry.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { OwnerChat } from "../../conversations/service.js";
import { AgentToolRefusal } from "../../conversations/errors.js";
import { WorkspaceService } from "../../workspaces/service.js";
import { WorkspaceError } from "../../workspaces/errors.js";
import { AttachmentService } from "../../attachments/service.js";
import { AttachmentError } from "../../attachments/errors.js";
import type { AgentProcessOperationBroker } from "../processes/operations.js";
import {
  defineAgentTool,
  type AgentToolEntry,
  type AgentToolIdentity,
  type CurrentAgentToolRun,
} from "./entry.js";

export type AgentToolCallResult = { ok: true; result: unknown } | { ok: false; error: string };

/** The only Agent tool boundary: discovery, parsing, dispatch and public error mapping. */
export class AgentTools {
  private readonly operations: Map<string, AgentToolEntry>;
  private readonly meta: Map<string, AgentToolEntry>;

  constructor(
    private readonly database: Database.Database,
    chat: OwnerChat,
    workspace: WorkspaceService,
    attachments: AttachmentService,
    processes: AgentProcessOperationBroker,
  ) {
    this.operations = new Map(
      Object.entries({
        ...chat.agentTools(),
        ...workspace.agentTools(),
        ...attachments.agentTools(),
        ...processes.agentTools(),
        ...new AgentHistory(database).agentTools(),
      }),
    );
    this.meta = new Map(
      Object.entries({
        "tools.list": defineAgentTool({ description: "", schema: z.object({}).strict() }, () => ({
          tools: [...this.operations].map(([name, entry]) => ({
            name,
            description: entry.description,
          })),
        })),
        "tools.describe": defineAgentTool(
          { description: "", schema: z.object({ name: z.string().min(1).max(128) }).strict() },
          (identity, input) => {
            const entry = this.operation(input.name);
            return {
              name: input.name,
              description: entry.description,
              inputSchema: z.toJSONSchema(entry.schema),
            };
          },
        ),
        "tools.call": defineAgentTool(
          {
            description: "",
            schema: z
              .object({ name: z.string().min(1).max(128), input: z.record(z.string(), z.json()) })
              .strict(),
          },
          (identity, input) => this.operation(input.name).invoke(identity, input.input),
        ),
      }),
    );
  }

  async execute(
    identity: AgentToolIdentity,
    operation: string,
    input: unknown,
  ): Promise<AgentToolCallResult> {
    let accept!: () => void;
    let refuse!: (error: unknown) => void;
    const committed = new Promise<void>((resolve, reject) => {
      accept = resolve;
      refuse = reject;
    });
    // A synchronous refusal may have no node continuation waiting on this promise.
    void committed.catch(() => {});
    let execution: unknown;
    let unexpectedError = "Agent tool request was refused";
    try {
      const entry = this.meta.get(operation);
      if (!entry) throw new AgentToolRefusal("Unknown operation");
      // The selected operation owns its existing unexpected-failure message; parsing and
      // domain refusals still have one mapping here for synchronous and asynchronous tools.
      if (
        operation === "tools.call" &&
        typeof input === "object" &&
        input !== null &&
        "name" in input &&
        typeof input.name === "string"
      )
        unexpectedError = this.operations.get(input.name)?.unexpectedError ?? unexpectedError;
      const { result } = this.database
        .transaction(() => {
          const run = this.currentRun(identity);
          // Synchronous effects and the synchronous preparation of node intents are
          // accepted under this lock. Network continuations await committed below.
          execution = entry.invoke(
            {
              ...identity,
              run,
              committed,
              requireCurrentRun: () => {
                this.currentRun(identity);
              },
              request: { operation, input },
            },
            input,
          );
          return { result: execution };
        })
        .immediate();
      accept();
      return { ok: true, result: await result };
    } catch (error) {
      refuse(error);
      // COMMIT can fail after an asynchronous handler has prepared its intent. Drain
      // its rejected continuation too, so neither it nor its bookkeeping is orphaned.
      if (execution instanceof Promise) await execution.catch(() => {});
      if (error instanceof z.ZodError) return { ok: false, error: "Invalid tool input" };
      if (
        error instanceof AgentToolRefusal ||
        error instanceof WorkspaceError ||
        error instanceof AttachmentError
      )
        return { ok: false, error: error.message };
      return { ok: false, error: unexpectedError };
    }
  }

  private operation(name: string): AgentToolEntry {
    const entry = this.operations.get(name);
    if (!entry) throw new AgentToolRefusal("Unknown operation");
    return entry;
  }

  private currentRun(identity: AgentToolIdentity): CurrentAgentToolRun {
    const run = this.database
      .prepare(
        `SELECT r.id AS run_id,r.agent_id,r.node_id,r.delivery_id AS action_scope_id,
              r.input_end_seq,s.id AS session_id,d.channel_id
       FROM owner_agent_runs r
       JOIN owner_agent_sessions s ON s.agent_id=r.agent_id
       JOIN owner_message_deliveries d ON d.id=r.delivery_id
       WHERE r.id=? AND r.agent_id=? AND r.node_id=? AND r.state='running'`,
      )
      .get(identity.runId, identity.agentId, identity.nodeId);
    if (!run) throw new AgentToolRefusal("Agent run is no longer active");
    return currentAgentToolRunSchema.parse(run);
  }
}
