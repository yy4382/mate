/** Conversation positions and Agent attention are control-plane facts. */
export const conversationAttentionSchema = `
CREATE INDEX owner_messages_thread ON owner_messages(channel_id,root_id,order_seq);
CREATE TABLE owner_agent_message_attention (
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  message_id TEXT NOT NULL REFERENCES owner_messages(id),
  unread INTEGER NOT NULL DEFAULT 1 CHECK(unread IN (0,1)),
  seen INTEGER NOT NULL DEFAULT 0 CHECK(seen IN (0,1)),
  deferred INTEGER NOT NULL DEFAULT 0 CHECK(deferred IN (0,1)),
  muted INTEGER NOT NULL DEFAULT 0 CHECK(muted IN (0,1)),
  presented INTEGER NOT NULL DEFAULT 0 CHECK(presented IN (0,1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(agent_id,message_id)
);
INSERT INTO owner_agent_message_attention(agent_id,message_id,updated_at)
SELECT d.recipient_id,d.message_id,d.created_at
FROM owner_message_deliveries d JOIN owner_agents a ON a.id=d.recipient_id
WHERE d.recipient_kind='agent';
CREATE TABLE owner_conversation_presentations (
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  conversation_id INTEGER NOT NULL,
  message_id TEXT NOT NULL REFERENCES owner_messages(id),
  PRIMARY KEY(agent_id,conversation_id,message_id)
);
CREATE TABLE owner_agent_drafts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES owner_agents(id),
  channel_id TEXT NOT NULL REFERENCES owner_channels(id),
  root_id TEXT REFERENCES owner_messages(id),
  quote_id TEXT REFERENCES owner_messages(id),
  text TEXT NOT NULL,
  input_end_seq INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK(state IN ('editing','kept','deferred','abandoned','ready','sent')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX owner_agent_drafts_agent ON owner_agent_drafts(agent_id,state,updated_at);
CREATE TABLE owner_agent_draft_reviews (
  draft_id TEXT NOT NULL REFERENCES owner_agent_drafts(id),
  message_id TEXT NOT NULL REFERENCES owner_messages(id),
  PRIMARY KEY(draft_id,message_id)
);
`;
