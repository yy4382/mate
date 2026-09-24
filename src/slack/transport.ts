import { slackTextMatches } from "./text.js";
import { WebClient } from "@slack/web-api";
import type {
  ExternalMessageTransport,
  DispatchEnvelope,
  DispatchFailure,
  MessageConfirmation,
} from "../conversations/output.js";
import {
  slackBoundaryWaitReason,
  slackReady,
  slackTargetWaitReason,
  slackWaitReason,
  type SlackBoundaryReadiness,
  type SlackReadiness,
  type SlackTargetNeed,
} from "./readiness.js";
import type { ConversationTarget } from "../domain/conversations.js";
import type { Store } from "../storage/store.js";
import type { SlackMapper } from "./mapper.js";

/** Slack already cannot be reached for this installation, so crossing the boundary is pointless. */
export class SlackNotReadyError extends Error {
  constructor(readonly reason: string) {
    super(`Slack is not ready: ${reason}`);
    this.name = "SlackNotReadyError";
  }
}
/**
 * Readiness of each installation and of each target it acts on, published by the Slack runtime
 * that owns the connection. Every caller that would otherwise cross this boundary for a not-ready
 * installation or target reads it here, so the work waits with its durable record instead of
 * failing or reporting an unknown outcome.
 */
export interface SlackReadinessPort extends SlackBoundaryReadiness {
  readyFor(actor: string): boolean;
  waitingFor(actor: string): SlackNotReadyError | undefined;
  /** Why work naming one target waits, when that target's own conditions are not established. */
  waitingForTarget(
    actor: string,
    conversationId: string,
    need: SlackTargetNeed,
  ): SlackNotReadyError | undefined;
  readyAgents(): readonly string[];
}
/** No automatic write retries. Immutable outbox identity crosses this boundary unchanged. */
export class CanonicalSlackTransport implements ExternalMessageTransport, SlackReadinessPort {
  readonly clients = new Map<string, WebClient>();
  private readonly abort = new AbortController();
  private readiness?: SlackReadiness;
  close(): void {
    this.abort.abort();
  }
  /** Called by the owning runtime on every readiness change; absent means "nothing known yet". */
  setReadiness(readiness: SlackReadiness): void {
    this.readiness = readiness;
  }
  readyFor(actor: string): boolean {
    return slackReady(this.readiness, actor);
  }
  waitingFor(actor: string): SlackNotReadyError | undefined {
    const reason = slackWaitReason(this.readiness, actor);
    return reason ? new SlackNotReadyError(reason) : undefined;
  }
  /**
   * A target whose permission is still unconfirmed waits, even if its access is cached as granted.
   * The target is named by the conversation the caller has, or by the platform channel itself for
   * a caller that only knows that; this adapter resolves the one it needs, so neither way to name
   * a target can quietly skip its conditions.
   */
  waitingForTarget(
    actor: string,
    conversationId: string,
    need: SlackTargetNeed,
  ): SlackNotReadyError | undefined {
    // The installation's own condition answers first, so a not-ready installation reports why it
    // waits even for a conversation this adapter cannot route yet.
    const installation = this.waitingFor(actor);
    if (installation) return installation;
    let channel = conversationId;
    try {
      channel = this.mapper.target({ conversationId }).channel;
    } catch {
      /* The caller may already have named the platform channel; the lookup below decides. */
    }
    return this.waitingForChannel(actor, channel, need);
  }
  /** The same wait named directly by platform channel, for a caller that only has the channel. */
  waitingForChannel(
    actor: string,
    channel: string,
    need: SlackTargetNeed,
  ): SlackNotReadyError | undefined {
    const reason = slackBoundaryWaitReason(this.readiness, actor, channel, need);
    return reason ? new SlackNotReadyError(reason) : undefined;
  }
  readyAgents(): readonly string[] {
    return this.mapper.config.agents
      .map((agent) => agent.id)
      .filter((agentId) => !!this.clients.get(agentId) && this.readyFor(agentId));
  }
  constructor(
    readonly store: Store,
    readonly mapper: SlackMapper,
    tokens?: Record<string, string>,
  ) {
    if (tokens) this.add(tokens);
  }
  /**
   * Install the bot clients of the Agents whose token is present. An Agent without a token keeps
   * no client and is reported as an installation that needs an operator, instead of failing the
   * whole daemon startup for one missing secret. A token for an Agent this application does not
   * serve is still a configuration error: it means the caller and the bindings disagree.
   */
  configure(tokens: Record<string, string>): void {
    if (this.clients.size) throw new Error("Slack transport is already configured");
    const bound = new Set(this.mapper.config.agents.map((agent) => agent.id)),
      unbound = Object.keys(tokens).filter((agentId) => !bound.has(agentId));
    if (unbound.length)
      throw new Error(`Slack transport tokens name unbound Agents: ${unbound.join(", ")}`);
    this.add(tokens);
  }
  private add(tokens: Record<string, string>): void {
    for (const [actor, token] of Object.entries(tokens))
      this.clients.set(
        actor,
        new WebClient(token, {
          retryConfig: { retries: 0 },
          rejectRateLimitedCalls: true,
          timeout: 15000,
          fetch: (input, init) =>
            fetch(input, {
              ...init,
              signal: AbortSignal.any([this.abort.signal, ...(init?.signal ? [init.signal] : [])]),
            }),
        }),
      );
  }
  /**
   * True while one target's permission has no current platform answer. Only the target's own fact
   * decides this, so an internal conversation is never held by its installation's Slack state.
   */
  pendingPermission(actor: string, target: ConversationTarget): boolean {
    let channel: string;
    try {
      channel = this.mapper.target(target).channel;
    } catch {
      // An internal or unrouted conversation is not a Slack target and never waits for one.
      return false;
    }
    return !!slackTargetWaitReason(this.readiness, actor, channel, "permission");
  }
  pendingInput(target: ConversationTarget): boolean {
    const external = this.mapper.target(target);
    return !!this.store.db
      .prepare(
        "SELECT 1 FROM ingress WHERE normalized=0 AND (json_extract(body,'$.event.channel')=? OR json_extract(body,'$.command') IS NOT NULL)",
      )
      .get(external.channel);
  }
  async post(request: DispatchEnvelope): Promise<MessageConfirmation> {
    const waiting = this.waitingForTarget(
      request.actor,
      request.target.conversationId,
      "permission",
    );
    if (waiting) throw waiting;
    const client = this.clients.get(request.actor);
    if (!client) throw new Error("Missing Slack client");
    const target = this.mapper.target(request.target),
      agent = this.mapper.config.agents.find((a) => a.id === request.actor);
    if (!agent) throw new Error("Missing Slack identity");
    const result = await client.chat.postMessage({
      channel: target.channel,
      ...(target.thread ? { thread_ts: target.thread } : {}),
      text: request.text,
      metadata: {
        event_type: "mate_outbox",
        event_payload: { id: request.id, request_hash: request.requestHash },
      },
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!result.ts || (result.channel && result.channel !== target.channel))
      throw new Error("Invalid Slack receipt");
    return {
      message: this.mapper.message({
        ...target,
        ts: result.ts,
        revision: result.ts,
        text: request.text,
        deleted: false,
        user: agent.slackUserId,
        bot: agent.slackBotId,
      }),
      receipt: { ts: result.ts },
    };
  }
  matchesText(expected: string, observed: string): boolean {
    return slackTextMatches(expected, observed);
  }
  classify(error: unknown): DispatchFailure {
    // A not-ready installation keeps the durable record pending: nothing crossed the boundary, so
    // this is a wait, never an unknown external outcome.
    if (error instanceof SlackNotReadyError) return { kind: "retry", afterMs: 5000 };
    const e = error as { code?: string; retryAfter?: number; data?: { error?: string } };
    if (e?.code === "slack_webapi_rate_limited_error" && Number.isFinite(e.retryAfter))
      return { kind: "retry", afterMs: Math.max(1, e.retryAfter!) * 1000 };
    if (
      e?.code === "slack_webapi_platform_error" &&
      [
        "not_authed",
        "invalid_auth",
        "token_revoked",
        "account_inactive",
        "channel_not_found",
        "not_in_channel",
        "is_archived",
        "msg_too_long",
        "no_text",
        "restricted_action",
        "cannot_reply_to_message",
      ].includes(e.data?.error ?? "")
    )
      return { kind: "rejected", reason: e.data!.error! };
    return { kind: "unknown" };
  }
}
