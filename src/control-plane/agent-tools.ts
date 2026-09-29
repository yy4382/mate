import type Database from "better-sqlite3";
import { z } from "zod";
import { OwnerChat, AgentToolRefusal } from "./owner-chat.js";
import { WorkspaceService, WorkspaceError } from "./workspace.js";
import { AttachmentService, AttachmentError } from "./attachments.js";
import type { AgentProcessOperationBroker } from "./agent-process-operations.js";
import {
  defineAgentTool,
  type AgentToolEntry,
  type AgentToolIdentity,
} from "./agent-tool-entry.js";

export type AgentToolCallResult = { ok: true; result: unknown } | { ok: false; error: string };

/** The only Agent tool boundary: discovery, parsing, dispatch and public error mapping. */
export class AgentTools {
  private readonly operations: Map<string, AgentToolEntry>;
  private readonly meta: Map<string, AgentToolEntry>;

  constructor(
    database: Database.Database,
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
        ...processes.agentTools(chat),
      }),
    );
    const checked = (identity: AgentToolIdentity) =>
      database
        .transaction(() =>
          chat.requireActiveAgentToolRun(identity.runId, identity.nodeId, identity.agentId),
        )
        .immediate();
    this.meta = new Map(
      Object.entries({
        "tools.list": defineAgentTool(
          { description: "", schema: z.object({}).strict() },
          (identity) => {
            checked(identity);
            return {
              tools: [...this.operations].map(([name, entry]) => ({
                name,
                description: entry.description,
              })),
            };
          },
        ),
        "tools.describe": defineAgentTool(
          { description: "", schema: z.object({ name: z.string().min(1).max(128) }).strict() },
          (identity, input) => {
            checked(identity);
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
          (identity, input) => {
            checked(identity);
            return this.operation(input.name).invoke(identity, input.input);
          },
        ),
      }),
    );
  }

  async execute(
    identity: AgentToolIdentity,
    operation: string,
    input: unknown,
  ): Promise<AgentToolCallResult> {
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
      return {
        ok: true,
        result: await entry.invoke({ ...identity, request: { operation, input } }, input),
      };
    } catch (error) {
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
}
