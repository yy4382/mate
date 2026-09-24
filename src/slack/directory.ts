import { SlackMembership } from "./membership.js";
import type {
  ConversationDirectory,
  Space,
  SpacesResult,
  MembersResult,
  OpenDMResult,
} from "../conversations/directory.js";
import type { WebClient } from "@slack/web-api";
import type { RunToken } from "../storage/store.js";
import type { Conversations as Messages } from "../conversations/messages.js";
import type { SlackMapper } from "./mapper.js";
import { slackPrincipal, slackUserForPrincipal } from "./principals.js";
import type { Principal } from "../domain/messages.js";
import { LegacyArguments } from "./legacy-arguments.js";

/** Identity and membership come from the acting bot's authenticated Slack client. */
export class Directory implements ConversationDirectory {
  constructor(
    readonly messages: Messages,
    readonly clients: Map<string, WebClient>,
    readonly mapper: SlackMapper,
  ) {
    this.membershipFacts = new SlackMembership(messages, clients, mapper);
  }
  private readonly membershipFacts: SlackMembership;
  refresh(actor: string, conversationId: string, signal: AbortSignal) {
    return this.membershipFacts.refresh(actor, conversationId, signal);
  }
  private client(actor: string): WebClient {
    this.messages.agent(actor);
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
