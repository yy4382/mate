import { SlackMembership } from "./membership.js";
import type {
  ConversationDirectory,
  InviteResult,
  Space,
  SpacesResult,
  MembersResult,
  OpenDMResult,
} from "../conversations/directory.js";
import type { WebClient } from "@slack/web-api";
import type { Effect, RunToken } from "../storage/store.js";
import type { Conversations as Messages } from "../conversations/messages.js";
import type { SlackMapper } from "./mapper.js";
import type { SlackReadinessPort } from "./transport.js";
import { slackPrincipal, slackUserForPrincipal } from "./principals.js";
import type { Principal } from "../domain/messages.js";
import { LegacyArguments } from "./legacy-arguments.js";

/**
 * Slack's definite refusal of one invitation, including a workspace policy that forbids it. Every
 * other platform answer is treated as possibly having left an effect behind.
 * https://docs.slack.dev/reference/methods/conversations.invite/
 */
const inviteRefusals = new Set([
  "access_denied",
  "accesslimited",
  "account_inactive",
  "app_cannot_join_channel",
  "cant_invite",
  "cant_invite_self",
  "channel_not_found",
  "deprecated_endpoint",
  "ekm_access_denied",
  "enterprise_is_restricted",
  "external_channel_migrating",
  "invalid_arg_name",
  "invalid_arguments",
  "invalid_array_arg",
  "invalid_auth",
  "invalid_charset",
  "invalid_form_data",
  "invalid_post_type",
  "invitee_cant_see_channel",
  "is_archived",
  "method_deprecated",
  "method_not_supported_for_channel_type",
  "missing_post_type",
  "missing_scope",
  "no_external_invite_permission",
  "no_permission",
  "no_user",
  "not_allowed_token_type",
  "not_authed",
  "not_in_channel",
  "org_login_required",
  "org_user_not_in_team",
  "ratelimited",
  "restricted_action",
  "token_revoked",
  "user_not_found",
]);
/** The platform reason and whether Slack states the request was not carried out at all. */
function inviteFailure(error: unknown): { reason?: string; definite: boolean } {
  const failure = error as { code?: string; data?: { error?: string } };
  if (failure?.code === "slack_webapi_rate_limited_error")
    return { reason: "ratelimited", definite: true };
  if (failure?.code !== "slack_webapi_platform_error") return { definite: false };
  const reason = failure.data?.error;
  return reason ? { reason, definite: inviteRefusals.has(reason) } : { definite: false };
}

/** Identity and membership come from the acting bot's authenticated Slack client. */
export class Directory implements ConversationDirectory {
  constructor(
    readonly messages: Messages,
    readonly clients: Map<string, WebClient>,
    readonly mapper: SlackMapper,
    /** Connection readiness of each installation; absent means no wait is known. */
    readonly readiness?: Pick<SlackReadinessPort, "waitingFor">,
  ) {
    this.membershipFacts = new SlackMembership(messages, clients, mapper);
  }
  private readonly membershipFacts: SlackMembership;
  refresh(actor: string, conversationId: string, signal: AbortSignal) {
    return this.membershipFacts.refresh(actor, conversationId, signal);
  }
  private client(actor: string): WebClient {
    this.messages.agent(actor);
    // A platform read waits for its own installation instead of failing as a permission problem.
    const waiting = this.readiness?.waitingFor(actor);
    if (waiting) throw waiting;
    const client = this.clients.get(actor);
    if (!client) throw new Error("Slack client unavailable");
    return client;
  }
  async spaces(actor: string, maxPages = 10, onPage?: () => void): Promise<SpacesResult> {
    const client = this.client(actor),
      spaces: Space[] = [],
      channels = [],
      inaccessibleSystemDms: string[] = [];
    const version = this.messages.membershipVersion(actor);
    let cursor: string | undefined,
      pages = 0;
    const seen = new Set<string>();
    do {
      const result = await client.users.conversations({
        types: "public_channel,private_channel,im,mpim",
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const c of result.channels ?? [])
        if (c.id && /^[CDG][A-Z0-9]+$/.test(c.id)) {
          const bound = this.messages.references.findConversation({
            provider: "slack",
            workspace: this.mapper.config.teamId,
            externalId: c.id,
          });
          if (bound && this.messages.references.conversation(bound).authority === "internal")
            continue;
          // Slack lists its own Slackbot DM but can reject conversations.info for it.
          // It is not an Agent workspace; revoke any access persisted by an older run.
          if (c.is_im && c.user === "USLACKBOT") {
            if (bound) inaccessibleSystemDms.push(bound);
            continue;
          }
          channels.push(c);
          spaces.push({
            conversationId: this.mapper.conversation(c.id),
            source: "external",
            name: c.name,
            purpose: c.purpose?.value,
            principal: c.user ? slackPrincipal(this.mapper.config, c.user) : undefined,
            archived: !!c.is_archived,
            kind: c.is_im ? "dm" : "channel",
          });
        }
      const next = result.response_metadata?.next_cursor || undefined;
      if (next && seen.has(next)) throw new Error("Slack conversation cursor repeated");
      if (next) seen.add(next);
      cursor = next;
      pages++;
      onPage?.();
    } while (cursor && pages < maxPages);
    if (version !== this.messages.membershipVersion(actor))
      return {
        spaces: [],
        coverage: [
          { source: "external", complete: false, reason: "membership changed during discovery" },
        ],
      };
    for (const conversationId of inaccessibleSystemDms)
      this.messages.membership(actor, conversationId, false);
    for (const c of channels) {
      this.messages.membership(actor, this.mapper.conversation(c.id!), !c.is_archived);
      if (c.is_im && c.user && !c.is_archived) {
        const codec = new LegacyArguments(this.messages.references, this.mapper.config),
          principal = slackPrincipal(this.mapper.config, c.user);
        for (const row of this.messages.store.db
          .prepare(
            "SELECT id,request FROM actions WHERE agent_id=? AND state='unknown' AND json_extract(request,'$.operation')='conversations.openDM'",
          )
          .all(actor) as { id: string; request: string }[]) {
          const request = codec.effect(JSON.parse(row.request));
          if (JSON.stringify(request.principal) === JSON.stringify(principal))
            this.messages.store.db
              .prepare("UPDATE actions SET state='succeeded',receipt=? WHERE id=?")
              .run(JSON.stringify({ conversationId: this.mapper.conversation(c.id!) }), row.id);
        }
      }
    }
    return {
      spaces,
      coverage: [
        {
          source: "external",
          complete: !cursor,
          reason: cursor ? "listing stopped before the last page" : undefined,
        },
      ],
    };
  }
  async members(actor: string, conversationId: string): Promise<MembersResult> {
    this.messages.requireAccess(actor, conversationId);
    const channel = this.mapper.target({ conversationId }).channel,
      client = this.client(actor),
      members: Principal[] = [];
    let cursor: string | undefined,
      pages = 0;
    do {
      const result = await client.conversations.members({
        channel,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      members.push(
        ...(result.members ?? []).map((user) => slackPrincipal(this.mapper.config, user)),
      );
      cursor = result.response_metadata?.next_cursor || undefined;
      pages++;
    } while (cursor && pages < 10);
    this.messages.requireAccess(actor, conversationId);
    return { members, incomplete: !!cursor };
  }
  /**
   * Invites one configured team Agent into an external channel through this Agent's own
   * installation. The inviter's current membership, the target identity and the platform's own
   * public/private permission decide the request; the invited Agent gains access only from a
   * member read that names it, and an unconfirmed attempt is verified through that read instead of
   * a second invitation.
   */
  async invite(
    run: RunToken,
    actionId: string,
    conversationId: string,
    agentId: string,
    signal: AbortSignal,
  ): Promise<InviteResult> {
    const m = this.messages,
      s = m.store,
      client = this.client(run.agentId),
      target = m.agent(agentId);
    if (target.id === run.agentId) throw new Error("An Agent cannot invite itself");
    const identity = m.references.conversation(conversationId);
    if (identity.authority !== "external" || identity.kind !== "channel")
      throw new Error("Only an external channel carries platform invitations");
    m.requireReadable(run.agentId);
    // The inviter's own current membership is the prerequisite for the platform request.
    m.requireAccess(run.agentId, conversationId);
    const user = slackUserForPrincipal(this.mapper.config, { kind: "agent", id: agentId });
    if (!/^U[A-Z0-9]+$/.test(user)) throw new Error("Invalid Slack user");
    s.assertRun(run);
    signal.throwIfAborted();
    const channel = this.mapper.target({ conversationId }).channel,
      action = m.writes.prepareAction(run, actionId, {
        operation: "conversations.invite",
        conversationId,
        agentId,
      });
    if (action.state === "succeeded" || action.state === "failed")
      return JSON.parse(action.receipt!) as InviteResult;
    // A previous attempt may have reached Slack without a confirmed result, including this same
    // action after a pause or restart fenced it. The platform's member list decides that outcome,
    // and no second invitation is sent while it stays unconfirmed.
    const uncertain = this.uncertainInvites(run.agentId, conversationId, agentId);
    if (uncertain.length) {
      // Another attempt for this channel and target is still crossing the boundary; its own
      // record decides the outcome, so this call neither refutes it nor starts a second one.
      if (uncertain.some((row) => row.id !== actionId && row.state === "executing"))
        return this.record(run, actionId, {
          status: "unknown",
          conversationId,
          agentId,
          reason: "invitation_in_flight",
        });
      const fact = await this.memberFact(run, conversationId, agentId);
      if (fact === "member") return this.confirm(run, actionId, conversationId, agentId, uncertain);
      if (fact === "absent") {
        // A complete member list that omits the target is the platform's evidence that the
        // earlier request did not land. This call still sends nothing: retrying is the caller's
        // deliberate next decision, never an automatic repeat of an unresolved invitation.
        const earlier: InviteResult = {
          status: "failed",
          conversationId,
          agentId,
          reason: "not_a_member_after_uncertain_attempt",
          verification: "membership_query",
        };
        for (const row of uncertain) this.refine(row.id, run.agentId, "failed", earlier);
        return this.record(run, actionId, {
          status: "failed",
          conversationId,
          agentId,
          reason: "not_sent_earlier_attempt_absent",
          verification: "membership_query",
        });
      }
      return this.record(run, actionId, {
        status: "unknown",
        conversationId,
        agentId,
        reason: "invitation_outcome_unverified",
      });
    }
    if (action.state !== "prepared") throw new Error("Invitation action is not executable");
    s.startAction(run, actionId);
    try {
      return await this.attempt(run, actionId, conversationId, agentId, client, channel, user);
    } catch (error) {
      // A started action must never stay executing: a run cannot complete with one, and the
      // caller learns the external effect is unknown instead of losing the request.
      try {
        this.record(run, actionId, {
          status: "unknown",
          conversationId,
          agentId,
          reason: "invitation_outcome_unknown",
        });
      } catch {
        /* The original failure is the one the caller has to see. */
      }
      throw error;
    }
  }
  /** Sends one invitation and turns the platform's answer into a definite or unconfirmed result. */
  private async attempt(
    run: RunToken,
    actionId: string,
    conversationId: string,
    agentId: string,
    client: WebClient,
    channel: string,
    user: string,
  ): Promise<InviteResult> {
    try {
      await client.conversations.invite({ channel, users: user });
    } catch (error) {
      const failure = inviteFailure(error);
      // Slack stating the target is already in the channel is itself a membership fact.
      if (failure.reason === "already_in_channel") {
        const fact = await this.memberFact(run, conversationId, agentId);
        if (fact === "member")
          return this.confirm(run, actionId, conversationId, agentId, [], "already_in_channel");
        return this.record(run, actionId, {
          status: "unknown",
          conversationId,
          agentId,
          reason:
            fact === "absent" ? "membership_evidence_conflict" : "invitation_outcome_unverified",
        });
      }
      return this.record(
        run,
        actionId,
        failure.definite
          ? {
              status: "failed",
              conversationId,
              agentId,
              reason: failure.reason ?? "platform_refused",
            }
          : {
              status: "unknown",
              conversationId,
              agentId,
              reason: failure.reason ?? "invitation_outcome_unknown",
            },
      );
    }
    // An accepted request is not membership: only the member list that names the target grants it.
    const fact = await this.memberFact(run, conversationId, agentId);
    if (fact === "member") return this.confirm(run, actionId, conversationId, agentId, []);
    return this.record(run, actionId, {
      status: "unknown",
      conversationId,
      agentId,
      reason: "invitation_accepted_membership_unconfirmed",
    });
  }
  /**
   * Reads the platform's current member list through this Agent's own installation. An unavailable
   * or incomplete listing can confirm a member but never absence.
   */
  private async memberFact(
    run: RunToken,
    conversationId: string,
    agentId: string,
  ): Promise<"member" | "absent" | "unknown"> {
    try {
      const { members, incomplete } = await this.members(run.agentId, conversationId);
      if (members.some((member) => member.kind === "agent" && member.id === agentId))
        return "member";
      return incomplete ? "unknown" : "absent";
    } catch {
      return "unknown";
    }
  }
  /** Invitations by this Agent for this channel and target whose Slack outcome is not confirmed. */
  private uncertainInvites(
    agentId: string,
    conversationId: string,
    targetAgentId: string,
  ): Effect[] {
    return (
      this.messages.store.db
        .prepare(
          "SELECT * FROM actions WHERE agent_id=? AND state IN ('executing','unknown') AND json_extract(request,'$.operation')='conversations.invite'",
        )
        .all(agentId) as Effect[]
    ).filter((row) => {
      const request = JSON.parse(row.request) as { conversationId?: unknown; agentId?: unknown };
      return request.conversationId === conversationId && request.agentId === targetAgentId;
    });
  }
  /**
   * Records the one fact that grants access: the platform's member list named the target. Earlier
   * uncertain attempts for the same channel and target become definite with the same evidence.
   */
  private confirm(
    run: RunToken,
    actionId: string,
    conversationId: string,
    agentId: string,
    others: readonly Effect[],
    reason?: string,
  ): InviteResult {
    const s = this.messages.store,
      result: InviteResult = {
        status: "succeeded",
        conversationId,
        agentId,
        verification: "membership_query",
        ...(reason ? { reason } : {}),
      };
    s.assertRun(run);
    s.atomic(() => {
      this.messages.membership(agentId, conversationId, true);
      for (const row of others)
        if (row.id !== actionId) this.refine(row.id, run.agentId, "succeeded", result);
      this.record(run, actionId, result);
    });
    return result;
  }
  /**
   * One definite outcome onto this call's own durable record. Starting and settling share one
   * transaction, so a failure never leaves the action executing and the run unable to complete.
   */
  private record(run: RunToken, actionId: string, result: InviteResult): InviteResult {
    const s = this.messages.store;
    try {
      s.atomic(() => {
        if (s.action(actionId)?.state === "prepared") s.startAction(run, actionId);
        s.settleAction(run, actionId, result.status, result);
      });
      return result;
    } catch {
      /* The run was fenced while this call was in flight, or the action is already settled. */
    }
    this.refine(actionId, run.agentId, result.status, result);
    // Returning a definite result without a durable one would tell the caller its effect is
    // settled when nothing recorded it. A fence leaves the row definite or unknown, never running.
    const state = this.messages.store.action(actionId)?.state;
    if (state === "prepared" || state === "executing")
      throw new Error("Invitation result was not recorded");
    return result;
  }
  /** Only the conservative unknown a pause or restart left is refined; a recorded effect is not. */
  private refine(
    id: string,
    agentId: string,
    state: InviteResult["status"],
    receipt: unknown,
  ): void {
    this.messages.store.refineFencedAction(id, agentId, state, receipt);
  }
  async openDM(
    run: RunToken,
    actionId: string,
    principal: Exclude<Principal, { kind: "unknown" }>,
    signal: AbortSignal,
  ): Promise<OpenDMResult> {
    const s = this.messages.store,
      client = this.client(run.agentId);
    const user = slackUserForPrincipal(this.mapper.config, principal);
    s.assertRun(run);
    signal.throwIfAborted();
    if (!/^U[A-Z0-9]+$/.test(user)) throw new Error("Invalid Slack user");
    const action = this.messages.writes.prepareAction(run, actionId, {
      operation: "conversations.openDM",
      principal,
    });
    if (action.state === "succeeded") {
      const receipt = JSON.parse(action.receipt!);
      return receipt.conversationId
        ? receipt
        : { conversationId: this.mapper.conversation(receipt.channel) };
    }
    if (action.state === "failed")
      return { status: "failed", receipt: JSON.parse(action.receipt!) };
    const codec = new LegacyArguments(this.messages.references, this.mapper.config);
    const uncertain = (
      s.db
        .prepare(
          "SELECT request FROM actions WHERE agent_id=? AND state IN ('executing','unknown') AND json_extract(request,'$.operation')='conversations.openDM'",
        )
        .all(run.agentId) as { request: string }[]
    ).some(
      (row) =>
        JSON.stringify(codec.effect(JSON.parse(row.request)).principal) ===
        JSON.stringify(principal),
    );
    if (action.state !== "prepared" || uncertain)
      throw new Error("DM opening outcome unknown; inspect spaces before retry");
    const identity = await client.users.info({ user });
    if (
      identity.user?.id !== user ||
      identity.user.deleted ||
      (identity.user.team_id && identity.user.team_id !== this.mapper.config.teamId)
    )
      throw new Error("User is not an active workspace member");
    signal.throwIfAborted();
    s.startAction(run, actionId);
    try {
      const result = await client.conversations.open({ users: user, return_im: true });
      if (!result.channel?.id || !/^D[A-Z0-9]+$/.test(result.channel.id))
        throw new Error("Invalid DM receipt");
      signal.throwIfAborted();
      s.assertRun(run);
      const target = { conversationId: this.mapper.conversation(result.channel.id) };
      s.atomic(() => {
        this.messages.membership(run.agentId, target.conversationId, true);
        s.settleAction(run, actionId, "succeeded", target);
      });
      return target;
    } catch (error) {
      const failure = error as { code?: string; data?: { error?: string } };
      const rejected =
        failure.code === "slack_webapi_rate_limited_error" ||
        (failure.code === "slack_webapi_platform_error" &&
          [
            "missing_scope",
            "invalid_auth",
            "not_authed",
            "token_revoked",
            "account_inactive",
            "user_not_found",
            "user_not_visible",
            "cannot_dm_bot",
            "cannot_dm_self",
            "restricted_action",
            "no_permission",
            "user_disabled",
            "users_not_found",
            "invalid_users",
            "invalid_arguments",
            "invalid_arg_name",
            "invalid_array_arg",
            "invalid_charset",
            "invalid_form_data",
            "invalid_post_type",
            "invalid_types",
            "method_not_supported_for_channel_type",
            "not_allowed_token_type",
            "access_denied",
            "accesslimited",
            "channel_not_found",
            "deprecated_endpoint",
            "ekm_access_denied",
            "enterprise_is_restricted",
            "invalid_user_combination",
            "method_deprecated",
            "missing_post_type",
            "not_enough_users",
            "org_login_required",
            "ratelimited",
            "team_access_not_granted",
            "too_many_users",
            "token_expired",
            "user_is_bot",
            "user_is_restricted",
            "user_not_found",
            "user_not_visible",
          ].includes(failure.data?.error ?? ""));
      try {
        s.settleAction(run, actionId, rejected ? "failed" : "unknown", {
          reason: rejected
            ? (failure.data?.error ?? failure.code)
            : "DM opening or receipt uncertain",
        });
      } catch {
        /* run fenced */
      }
      throw error;
    }
  }
}
