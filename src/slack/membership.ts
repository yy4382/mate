import type { WebClient } from "@slack/web-api";
import type { Conversations } from "../conversations/messages.js";
import type { SlackMapper } from "./mapper.js";
import type { MembershipObservation } from "../conversations/directory.js";
import type { SlackBoundaryReadiness } from "./readiness.js";

/**
 * Reads the platform's current membership fact for one external conversation.
 * Membership itself is decided by an invitation or a removal in Slack, never here.
 */
export class SlackMembership {
  constructor(
    readonly messages: Conversations,
    readonly clients: Map<string, WebClient>,
    readonly mapper: SlackMapper,
    /** Connection readiness; absent means no wait is known. */
    readonly readiness?: SlackBoundaryReadiness,
  ) {}
  /**
   * The confirmation read waits for its own installation's connection, but never for the target's
   * own permission fact: this call is what establishes that fact, so waiting on it would deadlock.
   */
  private client(actor: string): WebClient {
    this.messages.agent(actor);
    this.messages.requireReadable(actor);
    const waiting = this.readiness?.waitingFor(actor);
    if (waiting) throw waiting;
    const client = this.clients.get(actor);
    if (!client) throw new Error("Agent has no Slack installation");
    return client;
  }
  async refresh(
    actor: string,
    conversationId: string,
    signal: AbortSignal,
  ): Promise<MembershipObservation> {
    signal.throwIfAborted();
    const m = this.messages,
      client = this.client(actor),
      identity = m.references.conversation(conversationId);
    if (identity.authority !== "external" || identity.kind !== "channel")
      return {
        status: "unsupported",
        conversationId,
        reason: "Only external channels carry platform membership",
      };
    const channel = this.mapper.target({ conversationId }).channel,
      version = m.membershipVersion(actor);
    const info = await client.conversations.info({ channel });
    signal.throwIfAborted();
    m.requireReadable(actor);
    if (info.channel?.id !== channel || typeof info.channel.is_member !== "boolean")
      throw new Error("Membership evidence unavailable");
    if (version !== m.membershipVersion(actor))
      throw new Error("Membership changed during refresh");
    const active = info.channel.is_member && !info.channel.is_archived;
    m.membership(actor, conversationId, active);
    return { status: "succeeded", conversationId, active };
  }
}
