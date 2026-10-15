import type Database from "better-sqlite3";

/** Business read/seen flags are shared; actual model presentation is conversation scoped. */
export function recordPresentation(
  db: Database.Database,
  agentId: string,
  conversationId: number,
  messageId: string,
  at: number,
) {
  if (conversationId === 1) {
    db.prepare(
      "UPDATE owner_agent_message_attention SET presented=1,updated_at=? WHERE agent_id=? AND message_id=?",
    ).run(at, agentId, messageId);
  }
  db.prepare(
    "INSERT OR IGNORE INTO owner_conversation_presentations(agent_id,conversation_id,message_id) VALUES(?,?,?)",
  ).run(agentId, conversationId, messageId);
}

export const presentationExistsSql = `(SELECT 1 FROM owner_agent_message_attention a WHERE a.agent_id=? AND a.message_id=m.id AND a.presented=1 AND ?=1
  UNION ALL SELECT 1 FROM owner_conversation_presentations p WHERE p.agent_id=? AND p.message_id=m.id AND p.conversation_id=?)`;
