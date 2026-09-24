import type { WebClient } from "@slack/web-api";
import type { Conversations } from "../conversations/messages.js";
import type { SlackMapper } from "./mapper.js";
import type { RunToken } from "../storage/store.js";
import type {
  DirectoryCapabilities,
  DiscoveryResult,
  MembershipResult,
  DiscoveredSpace,
} from "../conversations/directory.js";

// Documented validation/permission/state rejections for join/leave. Internal/fatal,
// service/transport failure and unrecognized errors may have applied a side effect.
const membershipRejections = new Set([
  "access_denied",
  "accesslimited",
  "account_inactive",
  "cant_leave_general",
  "channel_is_limited_access",
  "channel_not_found",
  "deprecated_endpoint",
  "ekm_access_denied",
  "enterprise_is_restricted",
  "invalid_arg_name",
  "invalid_arguments",
  "invalid_array_arg",
  "invalid_auth",
  "invalid_charset",
  "invalid_form_data",
  "invalid_post_type",
  "is_archived",
  "last_member",
  "method_deprecated",
  "method_not_supported_for_channel_type",
  "missing_post_type",
  "missing_scope",
  "no_permission",
  "not_allowed_token_type",
  "not_authed",
  "not_in_channel",
  "org_login_required",
  "ratelimited",
  "restricted_action",
  "team_access_not_granted",
  "team_added_to_org",
  "token_expired",
  "token_revoked",
  "two_factor_setup_required",
  "upgrade_required",
]);

/** Public metadata discovery and explicit, receipted channel membership changes. */
export class SlackParticipation {
  constructor(
    readonly messages: Conversations,
    readonly clients: Map<string, WebClient>,
    readonly mapper: SlackMapper,
  ) {}
  capabilities(actor: string, conversationId?: string): DirectoryCapabilities {
    this.messages.agent(actor);
    this.messages.requireReadable(actor);
    const available = this.clients.has(actor),
      channel =
        !conversationId || this.messages.references.conversation(conversationId).kind === "channel";
    return {
      discover: available,
      join: available && channel,
      leave: available && channel,
      refresh: available && channel,
      notes: available
        ? [
            "Discovery returns public metadata only, never read permission. Joining requires channels:join and a public channel; leave requires the platform scope for that channel. Private channels require invitation. DM membership controls are unsupported.",
          ]
        : ["Agent has no Slack installation"],
    };
  }
  async discover(actor: string, cursor?: string): Promise<DiscoveryResult> {
    this.messages.agent(actor);
    this.messages.requireReadable(actor);
    const client = this.clients.get(actor);
    if (!client)
      return {
        spaces: [],
        nextCursor: null,
        coverage: "public_metadata",
        supported: false,
        reason: "Agent has no Slack installation",
      };
    const result = await client.conversations.list({
      types: "public_channel",
      exclude_archived: true,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    this.messages.requireReadable(actor);
    const spaces: DiscoveredSpace[] = [];
    for (const c of result.channels ?? []) {
      if (!c.id || !/^C[A-Z0-9]+$/.test(c.id) || c.is_private || c.is_im || c.is_mpim) continue;
      const bound = this.messages.references.findConversation({
        provider: "slack",
        workspace: this.mapper.config.teamId,
        externalId: c.id,
      });
      if (bound && this.messages.references.conversation(bound).authority === "internal") continue;
      spaces.push({
        candidateId: JSON.stringify(["slack-public-channel", this.mapper.config.teamId, c.id]),
        name: c.name,
        purpose: c.purpose?.value,
        archived: !!c.is_archived,
      });
    }
    return {
      spaces,
      nextCursor: result.response_metadata?.next_cursor || null,
      coverage: "public_metadata",
      supported: true,
    };
  }
  async joinCandidate(
    run: RunToken,
    actionId: string,
    candidateId: string,
    signal: AbortSignal,
  ): Promise<MembershipResult> {
    const m = this.messages;
    m.store.assertRun(run);
    signal.throwIfAborted();
    const client = this.client(run.agentId);
    let parts: unknown;
    try {
      parts = JSON.parse(candidateId);
    } catch {
      throw new Error("Invalid discovery reference");
    }
    if (
      !Array.isArray(parts) ||
      parts.length !== 3 ||
      parts[0] !== "slack-public-channel" ||
      parts[1] !== this.mapper.config.teamId ||
      typeof parts[2] !== "string" ||
      !/^C[A-Z0-9]+$/.test(parts[2])
    )
      throw new Error("Invalid discovery reference");
    const bound = m.references.findConversation({
      provider: "slack",
      workspace: this.mapper.config.teamId,
      externalId: parts[2],
    });
    if (bound) return this.change(run, actionId, bound, "join", signal);
    // Candidate metadata is not a canonical room binding or an authorization token.
    // Only an explicit join intent may establish an external conversation identity.
    const info = await client.conversations.info({ channel: parts[2] });
    m.store.assertRun(run);
    signal.throwIfAborted();
    m.requireReadable(run.agentId);
    if (
      info.channel?.id !== parts[2] ||
      info.channel.is_private ||
      info.channel.is_im ||
      info.channel.is_mpim ||
      info.channel.is_archived
    )
      throw new Error("Joining requires a non-archived public channel");
    return this.change(run, actionId, this.mapper.conversation(parts[2]), "join", signal);
  }
  private client(actor: string): WebClient {
    this.messages.agent(actor);
    this.messages.requireReadable(actor);
    const client = this.clients.get(actor);
    if (!client) throw new Error("Agent has no Slack installation");
    return client;
  }
  private uncertain(actor: string, conversationId: string): boolean {
    return !!this.messages.store.db
      .prepare(
        "SELECT 1 FROM actions WHERE agent_id=? AND state IN ('executing','unknown') AND json_extract(request,'$.operation') IN ('conversations.join','conversations.leave') AND json_extract(request,'$.conversationId')=?",
      )
      .get(actor, conversationId);
  }
  async change(
    run: RunToken,
    actionId: string,
    conversationId: string,
    operation: "join" | "leave",
    signal: AbortSignal,
  ): Promise<MembershipResult> {
    const m = this.messages,
      s = m.store;
    s.assertRun(run);
    signal.throwIfAborted();
    const client = this.client(run.agentId),
      identity = m.references.conversation(conversationId);
    if (identity.authority !== "external" || identity.kind !== "channel")
      return {
        status: "unsupported",
        conversationId,
        reason: "Only external channel membership is supported",
      };
    const channel = this.mapper.target({ conversationId }).channel;
    const action = m.writes.prepareAction(run, actionId, {
      operation: `conversations.${operation}`,
      conversationId,
    });
    if (action.state === "succeeded" || action.state === "failed")
      return JSON.parse(action.receipt!);
    if (action.state !== "prepared" || this.uncertain(run.agentId, conversationId))
      return {
        status: "unknown",
        conversationId,
        reason: "Membership outcome unresolved; use conversations.refresh, do not repeat the write",
      };
    if (operation === "leave") m.requireAccess(run.agentId, conversationId);
    const version = m.membershipVersion(run.agentId);
    if (operation === "join") {
      const info = await client.conversations.info({ channel });
      s.assertRun(run);
      signal.throwIfAborted();
      m.requireReadable(run.agentId);
      if (
        info.channel?.id !== channel ||
        info.channel.is_private ||
        info.channel.is_im ||
        info.channel.is_mpim ||
        info.channel.is_archived
      )
        throw new Error("Joining requires a non-archived public channel");
    }
    if (m.membershipVersion(run.agentId) !== version)
      throw new Error("Membership changed before request; inspect and retry");
    if (this.uncertain(run.agentId, conversationId))
      return {
        status: "unknown",
        conversationId,
        reason: "Concurrent membership request; refresh before another write",
      };
    s.startAction(run, actionId);
    try {
      if (operation === "join") {
        const result = await client.conversations.join({ channel });
        if (!result.ok || result.channel?.id !== channel || result.channel.is_member !== true)
          throw new Error("Unconfirmed join response");
      } else {
        const result = await client.conversations.leave({ channel }).catch((error) => {
          if (error?.code === "slack_webapi_platform_error" && error?.data?.not_in_channel === true)
            return { ok: false, not_in_channel: true };
          throw error;
        });
        if (!result.ok && !(result as { not_in_channel?: boolean }).not_in_channel)
          throw new Error("Unconfirmed leave response");
      }
      s.assertRun(run);
      signal.throwIfAborted();
      m.requireReadable(run.agentId);
      if (m.membershipVersion(run.agentId) !== version)
        throw new Error("Concurrent membership change; refresh required");
      const receipt: MembershipResult = {
        status: "succeeded",
        conversationId,
        active: operation === "join",
      };
      s.atomic(() => {
        m.membership(run.agentId, conversationId, receipt.active!);
        s.settleAction(run, actionId, "succeeded", receipt);
      });
      return receipt;
    } catch (error) {
      const e = error as { code?: string; data?: { error?: string } };
      const rejected =
        e.code === "slack_webapi_rate_limited_error" ||
        (e.code === "slack_webapi_platform_error" && membershipRejections.has(e.data?.error ?? ""));
      const receipt: MembershipResult = {
        status: rejected ? "failed" : "unknown",
        conversationId,
        reason: rejected
          ? (e.data?.error ?? e.code!)
          : "Membership outcome unknown; inspect with conversations.refresh",
      };
      try {
        s.settleAction(run, actionId, rejected ? "failed" : "unknown", receipt);
      } catch {
        /* A stopped run is fenced and recovered as unknown. */
      }
      return receipt;
    }
  }
  async refresh(
    actor: string,
    conversationId: string,
    signal: AbortSignal,
  ): Promise<MembershipResult> {
    signal.throwIfAborted();
    const m = this.messages,
      client = this.client(actor),
      identity = m.references.conversation(conversationId);
    if (identity.authority !== "external" || identity.kind !== "channel")
      return {
        status: "unsupported",
        conversationId,
        reason: "Only external channels can refresh membership",
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
    const active = info.channel.is_member && !info.channel.is_archived,
      receipt: MembershipResult = { status: "succeeded", conversationId, active };
    m.store.atomic(() => {
      m.membership(actor, conversationId, active);
      // Desired state observed is sufficient for this state-setting operation. A negative
      // observation cannot prove a timed-out request will never take effect: keep unknown.
      for (const row of m.store.db
        .prepare(
          "SELECT id FROM actions WHERE agent_id=? AND state='unknown' AND json_extract(request,'$.operation')=? AND json_extract(request,'$.conversationId')=?",
        )
        .all(actor, active ? "conversations.join" : "conversations.leave", conversationId) as {
        id: string;
      }[]) {
        m.store.db
          .prepare("UPDATE actions SET state='succeeded',receipt=? WHERE id=?")
          .run(JSON.stringify({ ...receipt, reconciled: true }), row.id);
      }
    });
    return receipt;
  }
}
