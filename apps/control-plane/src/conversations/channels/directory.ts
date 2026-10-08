import type { OwnerChannel } from "@mate/protocol/owner";
import { channelVisibilitySchema } from "@mate/protocol/owner";
import type { AgentConversationFacts } from "../contracts.js";
import { AgentToolRefusal } from "../errors.js";
import {
  channelRowSchema,
  conversationRowSchema,
  toChannel,
  type ConversationRow,
} from "../rows.js";
import { conversationToolDefinitions } from "../tools/contracts.js";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ConversationEvents } from "../events.js";
import { defineConversationTool, type ConversationToolActions } from "../tools/actions.js";

export class ConversationDirectory {
  constructor(
    private readonly db: Database.Database,
    private readonly events: ConversationEvents,
    private readonly now: () => number,
    private readonly toolActions: ConversationToolActions,
  ) {}

  /** Create or return the one private owner conversation bound to this verified Agent. */
  getOrCreateAgentDirectChannel(agentId: string): OwnerChannel | undefined {
    return this.db
      .transaction(() => {
        const agent = z
          .looseObject({ id: z.string(), name: z.string(), stage: z.string() })
          .optional()
          .parse(
            this.db
              .prepare("SELECT a.id,a.name,a.stage FROM owner_agents a WHERE a.id=?")
              .get(agentId),
          );
        if (!agent || agent.stage !== "complete") return undefined;
        const existing = channelRowSchema.optional().parse(
          this.db
            .prepare(
              `SELECT c.id,c.name,c.description,c.visibility,c.archived,c.created_at,c.updated_at
             FROM owner_agent_direct_channels d JOIN owner_channels c ON c.id=d.channel_id
             WHERE d.agent_id=?`,
            )
            .get(agentId),
        );
        if (existing) return toChannel(existing);

        const id = randomUUID();
        const at = this.now();
        const channel: OwnerChannel = {
          id,
          name: `${agent.name} 私信`,
          description: `与 ${agent.name} 的所有者私信。`,
          visibility: "private",
          archived: false,
          createdAt: at,
          updatedAt: at,
        };
        this.db
          .prepare(
            "INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at) VALUES(?,?,?,'private',?,?)",
          )
          .run(id, channel.name, channel.description, at, at);
        this.db
          .prepare(
            "INSERT INTO owner_agent_direct_channels(agent_id,channel_id,created_at) VALUES(?,?,?)",
          )
          .run(agentId, id, at);
        this.db
          .prepare(
            "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,'human','owner',1,?),(?, 'agent', ?,1,?)",
          )
          .run(id, at, id, agentId, at);
        this.events.record("channel.created", id, channel);
        return channel;
      })
      .immediate();
  }

  /** True for the one-to-one conversations that must never follow channel visibility. */
  isDirectChannel(channelId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 WHERE EXISTS (
           SELECT 1 FROM owner_agent_direct_channels d WHERE d.channel_id=?
         ) OR EXISTS (
           SELECT 1 FROM owner_agent_peer_direct_channels p WHERE p.channel_id=?
         )`,
      )
      .get(channelId, channelId);
    return row !== undefined;
  }

  /** True only while this Agent holds an active membership in a live channel. */
  isAgentChannelMember(agentId: string, channelId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
         FROM owner_channels c
         JOIN owner_channel_memberships m
           ON m.channel_id=c.id AND m.principal_kind='agent' AND m.principal_id=? AND m.active=1
         WHERE c.id=? AND c.archived=0`,
      )
      .get(agentId, channelId);
    return row !== undefined;
  }

  readChannel(id: string): OwnerChannel {
    const row = channelRowSchema
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT id,name,description,visibility,archived,created_at,updated_at FROM owner_channels WHERE id=?",
          )
          .get(id),
      );
    if (!row) throw new Error("Created channel was not persisted");
    return toChannel(row);
  }

  private listAgentConversations(agentId: string) {
    const rows = z
      .looseObject({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        visibility: channelVisibilitySchema,
        direct_agent_id: z.string().nullable(),
        conversation_kind: z.union([z.literal("channel"), z.literal("dm")]),
        member: z.number(),
      })
      .array()
      .parse(
        this.db
          .prepare(
            `SELECT c.id,c.name,c.description,c.visibility,d.agent_id AS direct_agent_id,
                CASE WHEN d.agent_id IS NOT NULL OR p.channel_id IS NOT NULL
                     THEN 'dm' ELSE 'channel' END AS conversation_kind,
                COALESCE(m.active,0) AS member
         FROM owner_channels c
         LEFT JOIN owner_channel_memberships m
           ON m.channel_id=c.id AND m.principal_kind='agent' AND m.principal_id=?
         LEFT JOIN owner_agent_direct_channels d ON d.channel_id=c.id
         LEFT JOIN owner_agent_peer_direct_channels p ON p.channel_id=c.id
         WHERE c.archived=0 AND (m.active=1 OR (
           c.visibility='public' AND d.agent_id IS NULL AND p.channel_id IS NULL
         ))
         ORDER BY c.created_at,c.id`,
          )
          .all(agentId),
      );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      kind: row.conversation_kind,
      member: row.member === 1,
    }));
  }

  private listContactableAgents(agentId: string) {
    return z
      .looseObject({ id: z.string(), name: z.string(), role: z.string(), description: z.string() })
      .array()
      .parse(
        this.db
          .prepare(
            `SELECT a.id,a.name,a.role,a.description
         FROM owner_agents a JOIN nodes n ON n.id=a.node_id
         WHERE a.id<>? AND a.stage='complete'
           AND n.linux_username IS NOT NULL AND n.uid IS NOT NULL AND n.gid IS NOT NULL
           AND a.home IS NOT NULL
         ORDER BY a.created_at,a.id`,
          )
          .all(agentId),
      );
  }

  private getOrCreateAgentPeerDirectChannel(
    firstAgentId: string,
    secondAgentId: string,
  ): OwnerChannel {
    const ordered = [firstAgentId, secondAgentId].sort();
    const first = ordered[0];
    const second = ordered[1];
    if (first === undefined || second === undefined)
      throw new AgentToolRefusal("Direct-message target is not available");
    const existing = z
      .looseObject({ channel_id: z.string() })
      .optional()
      .parse(
        this.db
          .prepare(
            `SELECT channel_id FROM owner_agent_peer_direct_channels
           WHERE first_agent_id=? AND second_agent_id=?`,
          )
          .get(first, second),
      );
    if (existing) {
      const channel = this.readChannel(existing.channel_id);
      if (channel.archived) throw new AgentToolRefusal("Direct message is archived");
      return channel;
    }
    const participants = z
      .looseObject({ id: z.string(), name: z.string() })
      .array()
      .parse(
        this.db
          .prepare("SELECT id,name FROM owner_agents WHERE id IN (?,?) ORDER BY id")
          .all(first, second),
      );
    if (participants.length !== 2)
      throw new AgentToolRefusal("Direct-message target is not available");
    const id = randomUUID();
    const at = this.now();
    const names = new Map(participants.map((agent) => [agent.id, agent.name]));
    const firstName = names.get(first);
    const secondName = names.get(second);
    if (firstName === undefined || secondName === undefined)
      throw new AgentToolRefusal("Direct-message target is not available");
    this.db
      .prepare(
        `INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at)
         VALUES(?,?,?,'private',?,?)`,
      )
      .run(
        id,
        `${firstName} ↔ ${secondName} 私信`,
        `${firstName} 与 ${secondName} 的私信。`,
        at,
        at,
      );
    this.db
      .prepare(
        `INSERT INTO owner_agent_peer_direct_channels(
           channel_id,first_agent_id,second_agent_id,created_at
         ) VALUES(?,?,?,?)`,
      )
      .run(id, first, second, at);
    this.db
      .prepare(
        `INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at)
         VALUES(?,'human','owner',1,?),(?, 'agent', ?,1,?),(?, 'agent', ?,1,?)`,
      )
      .run(id, at, id, first, at, id, second, at);
    const channel = this.readChannel(id);
    this.events.record("channel.created", id, channel);
    return channel;
  }

  /** Read conversation metadata and this Agent's membership together. */
  private readConversationRow(agentId: string, conversationId: string) {
    return conversationRowSchema.optional().parse(
      this.db
        .prepare(
          `SELECT c.id,c.name,c.description,c.visibility,
                CASE WHEN d.agent_id IS NOT NULL OR p.channel_id IS NOT NULL
                     THEN 'dm' ELSE 'channel' END AS conversation_kind,
                m.active AS active_member
         FROM owner_channels c
         LEFT JOIN owner_channel_memberships m
           ON m.channel_id=c.id AND m.principal_kind='agent' AND m.principal_id=? AND m.active=1
         LEFT JOIN owner_agent_direct_channels d ON d.channel_id=c.id
         LEFT JOIN owner_agent_peer_direct_channels p ON p.channel_id=c.id
         WHERE c.id=? AND c.archived=0`,
        )
        .get(agentId, conversationId),
    );
  }

  private toConversationFacts(row: ConversationRow) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      kind: row.conversation_kind,
    };
  }

  /**
   * Conversation metadata for a read. A public channel stays readable without membership;
   * a private conversation, or any direct message, is readable only to an active member.
   */
  private readAgentConversation(agentId: string, conversationId: string) {
    const row = this.readConversationRow(agentId, conversationId);
    if (!row) return undefined;
    const readable =
      row.active_member === 1 ||
      (row.conversation_kind === "channel" &&
        row.visibility === "public" &&
        !this.isDirectChannel(conversationId));
    return readable ? this.toConversationFacts(row) : undefined;
  }

  /** Readable conversation metadata, or a refusal when this Agent may not read it. */
  requireReadableConversation(agentId: string, conversationId: string): AgentConversationFacts {
    const conversation = this.readAgentConversation(agentId, conversationId);
    if (!conversation) throw new AgentToolRefusal("Conversation is not available");
    return conversation;
  }

  /** Member-only conversation metadata; every write and every membership change uses this gate. */
  requireAgentConversation(agentId: string, conversationId: string): AgentConversationFacts {
    const row = this.readConversationRow(agentId, conversationId);
    if (!row || row.active_member !== 1)
      throw new AgentToolRefusal("Conversation is not available");
    return this.toConversationFacts(row);
  }

  isInvitableAgent(agentId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM owner_agents a JOIN nodes n ON n.id=a.node_id
         WHERE a.id=? AND a.stage='complete'
           AND n.linux_username IS NOT NULL AND n.uid IS NOT NULL AND n.gid IS NOT NULL
           AND a.home IS NOT NULL`,
      )
      .get(agentId);
    return !!row;
  }

  agentTools() {
    return {
      "agents.list": defineConversationTool(
        conversationToolDefinitions["agents.list"],
        (run, toolCallId, args) => {
          return { agents: this.listContactableAgents(run.agent_id) };
        },
      ),

      "conversations.list": defineConversationTool(
        conversationToolDefinitions["conversations.list"],
        (run, toolCallId, args) => {
          return { conversations: this.listAgentConversations(run.agent_id) };
        },
      ),

      "conversations.open_dm": defineConversationTool(
        conversationToolDefinitions["conversations.open_dm"],
        (run, toolCallId, args) => {
          if (args.targetAgentId === run.agent_id)
            throw new AgentToolRefusal("An Agent cannot open a direct message with itself");
          if (!this.isInvitableAgent(args.targetAgentId))
            throw new AgentToolRefusal("Direct-message target is not available");
          return this.toolActions.record(run, toolCallId, "conversations.open_dm", args, () =>
            this.getOrCreateAgentPeerDirectChannel(run.agent_id, args.targetAgentId),
          );
        },
      ),
    };
  }
}
