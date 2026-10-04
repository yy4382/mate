import type Database from "better-sqlite3";
import { z } from "zod";
import { AttachmentError } from "./errors.js";

/**
 * Attachment reads follow conversation visibility: a public channel's attachments are
 * readable by any Agent with an active run, while a private conversation stays member-only.
 * A direct message is never opened by visibility, even if one were ever stored public.
 */
export function authorizeAgentConversationRead(
  db: Database.Database,
  agentId: string,
  channelId: string,
): void {
  const row = db
    .prepare(
      `SELECT 1
         FROM owner_channels c
         LEFT JOIN owner_channel_memberships member ON member.channel_id=?
           AND member.principal_kind='agent' AND member.principal_id=? AND member.active=1
         WHERE c.id=? AND c.archived=0
           AND (member.active=1 OR (
             c.visibility='public'
             AND NOT EXISTS (
               SELECT 1 FROM owner_agent_direct_channels d WHERE d.channel_id=c.id
             )
             AND NOT EXISTS (
               SELECT 1 FROM owner_agent_peer_direct_channels p WHERE p.channel_id=c.id
             )
           ))`,
    )
    .get(channelId, agentId, channelId);
  if (!row)
    throw new AttachmentError("conversation_unavailable", "Agent 当前无权读取此对话的附件。", 403);
}

/** Publishing still requires membership, even where reading does not. */
export function authorizeAgentConversation(
  db: Database.Database,
  agentId: string,
  channelId: string,
): void {
  const row = db
    .prepare(
      `SELECT 1
         FROM owner_channels c
         JOIN owner_channel_memberships agent ON agent.channel_id=?
           AND agent.principal_kind='agent' AND agent.principal_id=? AND agent.active=1
         WHERE c.id=? AND c.archived=0`,
    )
    .get(channelId, agentId, channelId);
  if (!row)
    throw new AttachmentError(
      "conversation_unavailable",
      "Agent 当前不是此对话成员，无法发布附件。",
      403,
    );
}

export function requireOwnerMembership(
  db: Database.Database,
  channelId: string,
  forUpload: boolean,
): void {
  const row = z
    .looseObject({ archived: z.number() })
    .optional()
    .parse(
      db
        .prepare(
          `SELECT c.archived FROM owner_channels c
         JOIN owner_channel_memberships m ON m.channel_id=c.id
           AND m.principal_kind='human' AND m.principal_id='owner' AND m.active=1
         WHERE c.id=?`,
        )
        .get(channelId),
    );
  if (!row || (forUpload && row.archived))
    throw new AttachmentError("conversation_unavailable", "对话不存在、已归档或当前不可写。", 404);
}
