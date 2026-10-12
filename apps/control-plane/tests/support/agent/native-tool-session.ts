import type Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { z } from "zod";
import type { Message } from "@earendil-works/pi-ai";
import { AgentSession } from "../../../src/runtime/session/service.js";
import type { AgentToolIdentity } from "../../../src/runtime/tools/entry.js";

/** Domain-tool tests hold the real scheduler before opening its Harness. Passive native
 * writes supply the confirmed context at that seam, without a second transcript format. */
export class NativeToolSession {
  constructor(private readonly db: Database.Database) {}
  private path(agentId: string) {
    return join(dirname(this.db.name), "durable", `${agentId}.sqlite`);
  }
  async commit(
    { runId, nodeId, agentId }: Pick<AgentToolIdentity, "runId" | "nodeId" | "agentId">,
    entry: { id: string; message: Exclude<Message, { role: "system" }> },
  ) {
    const run = this.db
      .prepare(
        `SELECT 1 FROM owner_agent_runs
      WHERE id=? AND node_id=? AND agent_id=? AND state='running'`,
      )
      .get(runId, nodeId, agentId);
    if (!run) return false;
    const path = this.path(agentId);
    mkdirSync(dirname(path), { recursive: true });
    const storage = await openNodeSqliteStorage(path);
    const harness = await Harness.open(
      storage,
      { models: builtinModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const conversation = await harness.root(BACKGROUND_CONTEXT);
      // The public Session transaction records passive fixture context. Unlike
      // Conversation.submit(), it never resumes the Harness scheduler.
      await harness.commit(async (tx) => {
        const requestId = `delivery:${entry.id}`;
        if (await tx.submissionByRequest(conversation.id, requestId)) return;
        const saved = await tx.appendEntry(conversation.id, {
          kind: "mate.recovery",
          data: { id: entry.id },
          model: [entry.message],
        });
        await tx.createSubmission({
          conversationId: conversation.id,
          requestId,
          type: "write",
          status: "done",
          entry: saved.id,
        });
      }, BACKGROUND_CONTEXT);
      return true;
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  }
  async context(agentId: string) {
    if (!existsSync(this.path(agentId))) return [];
    const storage = await openNodeSqliteStorage(this.path(agentId));
    try {
      const conversations = await storage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT);
      const conversation = conversations.items[0];
      if (!conversation) return [];
      const page = await storage.scanEntries(
        { conversationId: conversation.id, order: "ascending" },
        1000,
        undefined,
        BACKGROUND_CONTEXT,
      );
      if (page.next) throw new Error("Native fixture context exceeded bound");
      return page.items.flatMap((entry) =>
        (entry.model ?? []).map((message) => ({
          id: z.object({ id: z.string() }).safeParse(entry.data).data?.id ?? String(entry.id),
          message,
        })),
      );
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  }
  async pendingCorrections(agentId: string, actionScopeId: string) {
    const context = await this.context(agentId);
    return new AgentSession(this.db)
      .pendingCorrections(agentId, actionScopeId)
      .filter((entry) => !context.some((previous) => previous.id === entry.id));
  }
}
