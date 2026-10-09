import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { defineAgentTool, type CurrentAgentToolRun } from "../../runtime/tools/entry.js";
import { AgentToolRefusal } from "../errors.js";

/** Keep schema output inference while adapting the registry identity to conversation rules. */
export function defineConversationTool<S extends z.ZodType>(
  definition: { description: string; schema: S },
  handler: (run: CurrentAgentToolRun, toolCallId: string, input: z.output<S>) => unknown,
) {
  return defineAgentTool(definition, (identity, input) =>
    handler(identity.run, identity.toolCallId, input),
  );
}

/** Persist and reuse one tool effect under the caller's synchronous transaction. */
export class ConversationToolActions {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number,
  ) {}

  record(
    run: CurrentAgentToolRun,
    toolCallId: string,
    operation: string,
    input: unknown,
    effect: () => unknown,
  ): unknown {
    const validId = z.string().min(1).max(500).safeParse(toolCallId);
    if (!validId.success) throw new AgentToolRefusal("Invalid action ID");
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ operation, input }))
      .digest("hex");
    const existing = z
      .looseObject({ request_hash: z.string(), result_json: z.string() })
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT request_hash,result_json FROM owner_agent_tool_actions WHERE session_id=? AND action_id=?",
          )
          .get(run.session_id, toolCallId),
      );
    if (existing) {
      if (existing.request_hash !== requestHash)
        throw new AgentToolRefusal("Action ID was already used for a different request");
      return z.json().parse(JSON.parse(existing.result_json));
    }
    const result = effect();
    this.db
      .prepare(
        `INSERT INTO owner_agent_tool_actions(
           session_id,action_id,agent_id,operation,request_hash,result_json,created_at
         ) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        run.session_id,
        toolCallId,
        run.agent_id,
        operation,
        requestHash,
        JSON.stringify(result),
        this.now(),
      );
    return result;
  }
}
