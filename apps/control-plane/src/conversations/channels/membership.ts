import type { OwnerChannel } from "@mate/protocol/owner";
import type { NewOwnerChannel, OwnerChannelUpdate } from "../contracts.js";
import { AgentToolRefusal } from "../errors.js";
import { channelRowSchema, toChannel } from "../rows.js";
import { conversationToolDefinitions } from "../tools/contracts.js";

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { nodeAccountOf } from "../../nodes/identity.js";

import type { ConversationEvents } from "../events.js";
import { type ConversationToolActions, defineConversationTool } from "../tools/actions.js";
import type { ConversationDirectory } from "./directory.js";

export class ChannelMembership {
  constructor(
    private readonly db: Database.Database,
    private readonly directory: ConversationDirectory,
    private readonly events: ConversationEvents,
    private readonly now: () => number,
    private readonly toolActions: ConversationToolActions,
  ) {}

  createChannel(input: NewOwnerChannel): OwnerChannel {
    const id = randomUUID(),
      at = this.now();
    return this.db
      .transaction(() => {
        this.db
          .prepare(
            "INSERT INTO owner_channels(id,name,description,visibility,created_at,updated_at) VALUES(?,?,?,?,?,?)",
          )
          .run(id, input.name, input.description, input.visibility, at, at);
        this.db
          .prepare(
            "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,'human','owner',1,?)",
          )
          .run(id, at);
        const channel = this.directory.readChannel(id);
        this.events.record("channel.created", channel.id, channel);
        return channel;
      })
      .immediate();
  }

  listChannels(): OwnerChannel[] {
    const rows = channelRowSchema
      .array()
      .parse(
        this.db
          .prepare(
            "SELECT id,name,description,visibility,archived,created_at,updated_at FROM owner_channels ORDER BY created_at,id",
          )
          .all(),
      );
    return rows.map(toChannel);
  }

  listInvitableChannels(): OwnerChannel[] {
    const rows = channelRowSchema.array().parse(
      this.db
        .prepare(
          `SELECT c.id,c.name,c.description,c.visibility,c.archived,c.created_at,c.updated_at
         FROM owner_channels c
         WHERE c.archived=0
           AND NOT EXISTS (SELECT 1 FROM owner_agent_direct_channels d WHERE d.channel_id=c.id)
           AND NOT EXISTS (SELECT 1 FROM owner_agent_peer_direct_channels p WHERE p.channel_id=c.id)
         ORDER BY c.created_at,c.id`,
        )
        .all(),
    );
    return rows.map(toChannel);
  }

  /** Add a provisioned Agent to an active channel before its messages can be delivered. */
  inviteAgentToChannel(channelId: string, agentId: string): boolean {
    return this.db
      .transaction(() => {
        const session = z
          .looseObject({
            stage: z.string(),
            linux_username: z.string().nullable(),
            uid: z.number().nullable(),
            gid: z.number().nullable(),
            home: z.string().nullable(),
          })
          .optional()
          .parse(
            this.db
              .prepare(
                `SELECT a.stage,a.home,n.linux_username,n.uid,n.gid
             FROM owner_agent_sessions s JOIN owner_agents a ON a.id=s.agent_id
             JOIN nodes n ON n.id=a.node_id
             WHERE s.agent_id=?`,
              )
              .get(agentId),
          );
        if (!session || session.stage !== "complete" || !nodeAccountOf(session) || !session.home)
          return false;
        const channel = z
          .looseObject({ archived: z.number() })
          .optional()
          .parse(
            this.db
              .prepare(
                `SELECT c.archived FROM owner_channels c
             WHERE c.id=?
               AND NOT EXISTS (
                 SELECT 1 FROM owner_agent_direct_channels d WHERE d.channel_id=c.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM owner_agent_peer_direct_channels p WHERE p.channel_id=c.id
               )`,
              )
              .get(channelId),
          );
        if (!channel || channel.archived) return false;
        this.db
          .prepare(
            "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,'agent',?,1,?) ON CONFLICT(channel_id,principal_kind,principal_id) DO UPDATE SET active=1",
          )
          .run(channelId, agentId, this.now());
        return true;
      })
      .immediate();
  }

  /**
   * Let an Agent join a public channel it chose to take part in, under the same commit
   * that records the decision. Joining grants no read of the past: unread state is still
   * created only by the delivery snapshot of a later message, so old history is never
   * backfilled as unread, and an earlier re-join keeps the original joined_at.
   */
  joinAgentToPublicChannel(agentId: string, channelId: string): OwnerChannel | undefined {
    return this.db
      .transaction(() => {
        const channel = channelRowSchema.optional().parse(
          this.db
            .prepare(
              `SELECT c.id,c.name,c.description,c.visibility,c.archived,c.created_at,c.updated_at
             FROM owner_channels c
             WHERE c.id=? AND c.archived=0 AND c.visibility='public'
               AND NOT EXISTS (SELECT 1 FROM owner_agent_direct_channels d WHERE d.channel_id=c.id)
               AND NOT EXISTS (
                 SELECT 1 FROM owner_agent_peer_direct_channels p WHERE p.channel_id=c.id
               )`,
            )
            .get(channelId),
        );
        if (!channel) return undefined;
        this.db
          .prepare(
            "INSERT INTO owner_channel_memberships(channel_id,principal_kind,principal_id,active,joined_at) VALUES(?,'agent',?,1,?) ON CONFLICT(channel_id,principal_kind,principal_id) DO UPDATE SET active=1",
          )
          .run(channelId, agentId, this.now());
        return toChannel(channel);
      })
      .immediate();
  }

  updateChannel(id: string, input: OwnerChannelUpdate): OwnerChannel | undefined {
    return this.db
      .transaction(() => {
        const current = this.db.prepare("SELECT id FROM owner_channels WHERE id=?").get(id);
        if (!current) return undefined;
        // A direct message is a private conversation between fixed participants, so it can
        // never be published: otherwise every Agent could read it through the public path.
        if (input.visibility === "public" && this.directory.isDirectChannel(id))
          throw new Error("A direct message cannot be made public");

        this.db
          .prepare(
            "UPDATE owner_channels SET name=COALESCE(?,name),description=COALESCE(?,description),visibility=COALESCE(?,visibility),archived=COALESCE(?,archived),updated_at=? WHERE id=?",
          )
          .run(
            input.name ?? null,
            input.description ?? null,
            input.visibility ?? null,
            input.archived === undefined ? null : input.archived ? 1 : 0,
            this.now(),
            id,
          );
        const channel = this.directory.readChannel(id);
        this.events.record("channel.updated", channel.id, channel);
        return channel;
      })
      .immediate();
  }
  agentTools() {
    return {
      "conversations.join": defineConversationTool(
        conversationToolDefinitions["conversations.join"],
        (run, toolCallId, args) => {
          const alreadyMember = this.directory.isAgentChannelMember(
            run.agent_id,
            args.conversationId,
          );
          if (alreadyMember) {
            const conversation = this.directory.requireAgentConversation(
              run.agent_id,
              args.conversationId,
            );
            if (conversation.kind !== "channel")
              throw new AgentToolRefusal("Only a public channel can be joined");
            return this.toolActions.record(run, toolCallId, "conversations.join", args, () => ({
              conversationId: conversation.id,
              name: conversation.name,
              visibility: conversation.visibility,
              member: true,
              alreadyMember: true,
            }));
          }
          const conversation = this.directory.requireReadableConversation(
            run.agent_id,
            args.conversationId,
          );
          if (conversation.kind !== "channel" || conversation.visibility !== "public")
            throw new AgentToolRefusal("Only a public channel can be joined");
          return this.toolActions.record(run, toolCallId, "conversations.join", args, () => {
            const channel = this.joinAgentToPublicChannel(run.agent_id, args.conversationId);
            if (!channel) throw new AgentToolRefusal("Only a public channel can be joined");
            return {
              conversationId: channel.id,
              name: channel.name,
              visibility: channel.visibility,
              member: true,
              alreadyMember: false,
            };
          });
        },
      ),

      "conversations.invite": defineConversationTool(
        conversationToolDefinitions["conversations.invite"],
        (run, toolCallId, args) => {
          const conversation = this.directory.requireAgentConversation(
            run.agent_id,
            args.conversationId,
          );
          if (conversation.kind !== "channel")
            throw new AgentToolRefusal("Only a channel can receive an invitation");
          if (args.agentId === run.agent_id)
            throw new AgentToolRefusal("An Agent cannot invite itself");
          const currentMember = z
            .looseObject({ active: z.number() })
            .optional()
            .parse(
              this.db
                .prepare(
                  "SELECT active FROM owner_channel_memberships WHERE channel_id=? AND principal_kind='agent' AND principal_id=?",
                )
                .get(args.conversationId, args.agentId),
            );
          // A valid Agent invitation is effective at this same control-plane commit.
          if (!this.directory.isInviteableAgent(args.agentId))
            throw new AgentToolRefusal("Invitation target is not available");
          return this.toolActions.record(run, toolCallId, "conversations.invite", args, () => {
            if (!this.inviteAgentToChannel(args.conversationId, args.agentId))
              throw new AgentToolRefusal("Invitation target is not available");
            return {
              conversationId: args.conversationId,
              agentId: args.agentId,
              status: "succeeded",
              alreadyMember: currentMember?.active === 1,
            };
          });
        },
      ),
    };
  }
}
