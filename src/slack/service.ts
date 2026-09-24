import { slackControlCommand } from "./capabilities.js";
import { slackPrincipal } from "./principals.js";
import type { WebClient } from "@slack/web-api";
import type { Collaboration } from "../collaboration/service.js";
import type { Controls } from "../daemon/control.js";
import type { Ingress } from "../daemon/ingress.js";
import type { CanonicalSlackTransport as WebSlackTransport } from "./transport.js";
import type { DispatchEnvelope } from "../conversations/output.js";
import { Directory } from "./directory.js";
import {
  compareSlackTimestamps,
  recoverSlackHistory,
  scanSlackPages,
  slackScanDue,
  scheduleSlackScan,
} from "./history-recovery.js";
import { systemOrigin } from "./normalize.js";
import { mutableSystemInputsWarning, type SystemOperations } from "../policy/system-operations.js";

import { encode } from "../storage/store.js";
export function formatControlReply(value: unknown, limit = 15000): string {
  const full = typeof value === "string" ? value : encode(value);
  if (Buffer.byteLength(full) <= limit) return full;
  const fields =
    value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([key, item]) => [
            key,
            Array.isArray(item)
              ? { items: item.length }
              : item && typeof item === "object" && "atLeast" in item
                ? {
                    atLeast: (item as any).atLeast,
                    truncated: (item as any).truncated,
                  }
                : typeof item,
          ]),
        )
      : {};
  return encode({
    format: "mate.control-overflow.v1",
    truncated: true,
    bytes: Buffer.byteLength(full),
    fields,
    hint: "Use activity with a smaller limit/source/actor/kind filter, or the local control adapter for the complete structured result.",
  });
}
export class SlackService {
  private reconcileAfter = 0;
  private readonly gapsAwaitingDiscovery = new Set<string>();
  private readonly transportGeneration = new Map<string, number>();
  private currentTransport(agentId: string, generation: number): boolean {
    return (this.transportGeneration.get(agentId) ?? 0) === generation;
  }
  constructor(
    readonly c: Collaboration,
    readonly transport: WebSlackTransport,
    readonly ingress: Ingress,
    readonly controls: Controls,
    readonly stopping: () => boolean = () => false,
    readonly system?: SystemOperations,
  ) {}
  configured(actor: string): boolean {
    return !!this.transport.clients.get(actor)?.token;
  }
  supports(
    actor: string,
    target: import("../domain/conversations.js").ConversationTarget,
  ): boolean {
    if (!this.configured(actor)) return false;
    try {
      return (
        this.c.messages.references.conversation(target.conversationId).authority === "external" &&
        !!this.transport.mapper.target(target).channel
      );
    } catch {
      return false;
    }
  }
  async verify(): Promise<void> {
    for (const agent of this.transport.mapper.config.agents) {
      if (this.stopping()) return;
      const client = this.transport.clients.get(agent.id)!;
      const auth = await client.auth.test();
      if (
        auth.team_id !== this.transport.mapper.config.teamId ||
        auth.user_id !== agent.slackUserId ||
        auth.bot_id !== agent.slackBotId
      )
        throw new Error(`Slack installation mismatch: ${agent.id}`);
      const bot = await client.bots.info({ bot: agent.slackBotId });
      if (bot.bot?.app_id !== agent.slackAppId) throw new Error(`Slack app mismatch: ${agent.id}`);
    }
  }
  /**
   * Refresh the complete conversation set before history recovery. This is what
   * makes a DM first opened while Mate was offline discoverable: there may be
   * no local binding yet for membership() or catchUp() to inspect.
   */
  async discoverMembership(required = true, progress?: () => void): Promise<boolean> {
    const directory = new Directory(this.c.messages, this.transport.clients, this.transport.mapper);
    for (let attempt = 0; attempt < 3; attempt++) {
      let complete = true;
      try {
        for (const agent of this.transport.mapper.config.agents) {
          if (this.stopping()) return false;
          const result = await directory.spaces(agent.id, Number.POSITIVE_INFINITY, progress);
          if (result.incomplete) {
            complete = false;
            break;
          }
        }
      } catch (error) {
        if (required) throw error;
        this.c.store.audit("membership_discovery_unavailable", {
          error: String(error),
        });
        return false;
      }
      if (complete) {
        for (const agentId of this.gapsAwaitingDiscovery)
          this.c.attention.recordExternalHistoryGap(
            agentId,
            "slack_offline_edits_and_deletes_not_reconstructible",
          );
        this.gapsAwaitingDiscovery.clear();
        return true;
      }
    }
    const error = new Error("Slack conversation discovery did not reach a complete snapshot");
    if (required) throw error;
    this.c.store.audit("membership_discovery_unavailable", {
      error: error.message,
    });
    return false;
  }
  /** Establishes the first durable responsibility boundary without importing pre-Mate history. */
  bootstrapRecovery(at = Date.now()): void {
    const watermark = `${Math.floor(at / 1000)}.${String(at % 1000).padStart(3, "0")}000`;
    for (const agent of this.transport.mapper.config.agents) {
      const prior = this.c.store.db
        .prepare("SELECT ts FROM slack_cursors WHERE agent_id=? AND channel='*'")
        .get(agent.id);
      this.c.store.db
        .prepare(
          "INSERT INTO slack_cursors VALUES(?, '*', ?) ON CONFLICT(agent_id,channel) DO NOTHING",
        )
        .run(agent.id, watermark);
      if (prior) this.recordTransportGap(agent.id);
    }
  }
  /** Slack history omits deleted messages; fence prior views after any socket gap. */
  recordTransportGap(agentId: string): void {
    this.transportGeneration.set(agentId, (this.transportGeneration.get(agentId) ?? 0) + 1);
    this.c.attention.recordExternalHistoryGap(
      agentId,
      "slack_offline_edits_and_deletes_not_reconstructible",
    );
    this.gapsAwaitingDiscovery.add(agentId);
    this.c.store.db
      .prepare("DELETE FROM runtime_meta WHERE key=?")
      .run(`slack_changed_thread_due_v1:${agentId}`);
    const prefix = `slack_changed_threads_v1:${agentId}:`;
    this.c.store.db
      .prepare("DELETE FROM runtime_meta WHERE substr(key,1,?)=?")
      .run(prefix.length, prefix);
    const historyPrefix = `slack_history_v1:${agentId}:`;
    this.c.store.db
      .prepare("DELETE FROM runtime_meta WHERE substr(key,1,?)=?")
      .run(historyPrefix.length, historyPrefix);
    this.c.store.audit("slack_offline_delete_gap_fenced", { agentId });
  }
  async membership(required = true, progress?: () => void): Promise<boolean> {
    let complete = true;
    for (const agent of this.transport.mapper.config.agents) {
      if (this.stopping()) return false;
      const client = this.transport.clients.get(agent.id)!;
      const stored = this.c.store.db
        .prepare(
          "SELECT a.channel FROM channel_access a JOIN conversation_bindings b ON b.conversation_id=a.channel WHERE b.provider='slack' AND b.mode='primary' AND b.workspace=? AND a.agent_id=? AND a.active=1",
        )
        .all(this.transport.mapper.config.teamId, agent.id) as {
        channel: string;
      }[];
      for (const channel of new Set([
        ...Object.keys(agent.channels),
        ...stored.map((r) => this.transport.mapper.target({ conversationId: r.channel }).channel),
      ])) {
        if (this.stopping()) return false;
        const bound = this.c.messages.references.findConversation({
          provider: "slack",
          workspace: this.transport.mapper.config.teamId,
          externalId: channel,
        });
        if (bound && this.c.messages.references.conversation(bound).authority === "internal")
          continue;
        // Failure closes permission until a successful membership check.
        this.c.messages.membership(agent.id, this.transport.mapper.conversation(channel), false);
        const version = this.c.messages.membershipVersion(agent.id);
        try {
          const info = await client.conversations.info({ channel });
          if (this.stopping() || version !== this.c.messages.membershipVersion(agent.id)) continue;
          this.c.messages.membership(
            agent.id,
            this.transport.mapper.conversation(channel),
            info.channel?.is_member === true ||
              (channel.startsWith("D") && info.channel?.is_im === true),
          );
          progress?.();
        } catch {
          complete = false;
          this.c.store.audit("membership_unavailable", {
            agentId: agent.id,
            channel,
          });
        }
      }
    }
    if (required && !complete) throw new Error("Slack membership verification did not complete");
    return complete;
  }
  async catchUp(forceFullOldThreads = false, progress?: () => void): Promise<boolean> {
    const recoveryStarted = `${Math.floor(Date.now() / 1000)}.000000`;
    let complete = true;
    for (const agent of this.transport.mapper.config.agents) {
      if (this.stopping()) return false;
      const generation = this.transportGeneration.get(agent.id) ?? 0,
        current = () => this.currentTransport(agent.id, generation);
      const client = this.transport.clients.get(agent.id)!;
      const changedDueKey = `slack_changed_thread_due_v1:${agent.id}`,
        scanOldThreads =
          forceFullOldThreads || slackScanDue(this.c.store, changedDueKey, Date.now());
      let changedComplete = true;
      const global = this.c.store.db
        .prepare("SELECT ts FROM slack_cursors WHERE agent_id=? AND channel='*'")
        .get(agent.id) as { ts: string } | undefined;
      const channels = this.c.store.db
        .prepare(
          "SELECT a.channel FROM channel_access a JOIN conversation_bindings b ON b.conversation_id=a.channel WHERE b.provider='slack' AND b.mode='primary' AND b.workspace=? AND a.agent_id=? AND a.active=1",
        )
        .all(this.transport.mapper.config.teamId, agent.id) as {
        channel: string;
      }[];
      for (const { channel: conversationId } of channels) {
        const { channel } = this.transport.mapper.target({ conversationId });
        if (this.stopping()) return false;
        const checkpoint = this.c.store.db
          .prepare("SELECT ts FROM slack_cursors WHERE agent_id=? AND channel=?")
          .get(agent.id, channel) as { ts: string } | undefined;
        const oldest = checkpoint?.ts ?? global?.ts;
        if (
          oldest &&
          scanOldThreads &&
          !(await this.catchUpChangedThreads(
            agent.id,
            agent.slackAppId,
            channel,
            oldest,
            client,
            forceFullOldThreads ? undefined : 2,
            current,
            progress,
          ))
        ) {
          complete = false;
          changedComplete = false;
        }
        const recovered = await recoverSlackHistory({
          store: this.c.store,
          agentId: agent.id,
          cursorKey: channel,
          initialOldest: oldest,
          current,
          onPage: progress,
          fetch: async (state) => {
            if (this.stopping()) throw new Error("stopping");
            const result = await client.conversations.history({
              channel,
              limit: 100,
              include_all_metadata: true,
              ...(state.oldest ? { oldest: state.oldest, inclusive: true } : {}),
              ...(state.cursor ? { cursor: state.cursor } : {}),
            });
            return {
              messages: result.messages ?? [],
              next: result.response_metadata?.next_cursor || undefined,
            };
          },
          timestamp: (message: any) => message.ts,
          ingest: (msg: any) => {
            if (msg.ts)
              this.c.store.ingest(
                agent.slackAppId,
                `history:${channel}:${msg.ts}:${msg.edited?.ts ?? msg.ts}`,
                {
                  team_id: this.transport.mapper.config.teamId,
                  event: { ...msg, type: "message", channel },
                },
              );
          },
        });
        if (!recovered) {
          complete = false;
          this.c.store.audit("history_gap", {
            agentId: agent.id,
            channel,
            oldest: oldest ?? null,
            reason: "Slack history unavailable or incomplete; durable page retained",
          });
        }
      }
      if (!current()) complete = false;
      if (scanOldThreads && changedComplete && current())
        scheduleSlackScan(this.c.store, changedDueKey, Date.now() + 60 * 60_000);
    }
    if (!(await this.catchUpThreads(progress))) complete = false;
    if (complete)
      for (const agent of this.transport.mapper.config.agents)
        this.c.store.db
          .prepare(
            "INSERT INTO slack_cursors VALUES(?,?,?) ON CONFLICT(agent_id,channel) DO UPDATE SET ts=excluded.ts",
          )
          .run(agent.id, "*", recoveryStarted);
    return complete;
  }
  /** Finds replies written while offline even when the old root was never watched locally. */
  private async catchUpChangedThreads(
    agentId: string,
    appId: string,
    channel: string,
    oldest: string,
    client: WebClient,
    maxPages: number | undefined,
    current: () => boolean,
    progress?: () => void,
  ): Promise<boolean> {
    const scanKey = `slack_changed_threads_v1:${agentId}:${channel}`,
      anchorKey = `slack_changed_thread_anchor_v1:${agentId}:${channel}`;
    const saved = this.c.store.db
      .prepare("SELECT value FROM runtime_meta WHERE key=?")
      .get(anchorKey) as { value: string } | undefined;
    const anchor = saved ? (JSON.parse(saved.value) as { oldest?: unknown }) : { oldest };
    if (typeof anchor.oldest !== "string") throw new Error("Invalid changed thread scan anchor");
    if (!saved)
      this.c.store.db
        .prepare("INSERT INTO runtime_meta VALUES(?,?)")
        .run(anchorKey, JSON.stringify(anchor));
    oldest = anchor.oldest;
    try {
      const outcome = await scanSlackPages<any>({
        store: this.c.store,
        key: scanKey,
        current,
        onPage: progress,
        ...(maxPages ? { maxPages } : {}),
        fetch: async (cursor) => {
          if (this.stopping()) throw new Error("stopping");
          const result = await client.conversations.history({
            channel,
            limit: 100,
            include_all_metadata: true,
            ...(cursor ? { cursor } : {}),
          });
          return {
            messages: result.messages ?? [],
            next: result.response_metadata?.next_cursor || undefined,
          };
        },
        visit: async (roots) => {
          for (const root of roots) {
            if (this.stopping()) throw new Error("stopping");
            const thread = typeof root.ts === "string" ? root.ts : undefined,
              latest = typeof root.latest_reply === "string" ? root.latest_reply : undefined;
            if (!thread || !latest || compareSlackTimestamps(latest, oldest) < 0) continue;
            // A newly discovered old thread has no canonical root yet. Import it
            // as history so replies can refer to it without waking the Agent for
            // a message that predates Mate's responsibility boundary.
            const rootMessage = this.transport.mapper.message({
              channel,
              ts: thread,
              revision: root.edited?.ts ?? thread,
              text: root.text ?? "",
              deleted: false,
              user: root.user,
              bot: root.bot_id,
              files: root.files,
            });
            this.c.messages.recordHistory(
              systemOrigin(this.c.messages, rootMessage, root.metadata),
              [agentId],
            );
            const recovered = await recoverSlackHistory({
              store: this.c.store,
              agentId,
              cursorKey: `${channel}:${thread}`,
              initialOldest: oldest,
              current,
              onPage: progress,
              fetch: async (state) => {
                if (this.stopping()) throw new Error("stopping");
                const result = await client.conversations.replies({
                  channel,
                  ts: thread,
                  limit: 100,
                  include_all_metadata: true,
                  oldest,
                  inclusive: true,
                  ...(state.cursor ? { cursor: state.cursor } : {}),
                });
                return {
                  messages: result.messages ?? [],
                  next: result.response_metadata?.next_cursor || undefined,
                };
              },
              timestamp: (message: any) => message.ts,
              ingest: (message: any) => {
                if (message.ts && compareSlackTimestamps(message.ts, oldest) >= 0)
                  this.c.store.ingest(
                    appId,
                    `thread-discovery:${channel}:${message.ts}:${message.edited?.ts ?? message.ts}`,
                    {
                      team_id: this.transport.mapper.config.teamId,
                      event: {
                        ...message,
                        type: "message",
                        channel,
                        thread_ts: message.thread_ts ?? thread,
                      },
                    },
                  );
              },
            });
            if (!recovered) throw new Error("Slack changed thread recovery incomplete");
          }
        },
      });
      if (outcome !== "paused" && current())
        this.c.store.db.prepare("DELETE FROM runtime_meta WHERE key=?").run(anchorKey);
      return outcome !== "paused";
    } catch (error) {
      this.c.store.audit("history_gap", {
        agentId,
        channel,
        oldest,
        reason: "changed_thread_scan_unavailable",
        error: String(error),
      });
      return false;
    }
  }
  async catchUpThreads(progress?: () => void): Promise<boolean> {
    let complete = true;
    const s = this.c.store;
    const watches = s.db
      .prepare(
        "SELECT t.* FROM thread_watches t JOIN channel_access a ON a.agent_id=t.agent_id AND a.channel=t.channel JOIN conversation_bindings b ON b.conversation_id=t.channel WHERE a.active=1 AND b.provider='slack' AND b.mode='primary' AND b.workspace=?",
      )
      .all(this.transport.mapper.config.teamId) as {
      agent_id: string;
      channel: string;
      thread: string;
    }[];
    for (const internal of watches) {
      const target = this.transport.mapper.target({
          conversationId: internal.channel,
          threadId: internal.thread,
        }),
        watch = {
          agent_id: internal.agent_id,
          channel: target.channel,
          thread: target.thread!,
        };
      if (this.stopping()) return false;
      const agent = this.transport.mapper.config.agents.find((a) => a.id === watch.agent_id)!,
        client = this.transport.clients.get(agent.id)!;
      const cursorKey = `${watch.channel}:${watch.thread}`;
      const checkpoint = s.db
        .prepare("SELECT ts FROM slack_cursors WHERE agent_id=? AND channel=?")
        .get(agent.id, cursorKey) as { ts: string } | undefined;
      const oldest = checkpoint?.ts ?? watch.thread;
      const generation = this.transportGeneration.get(agent.id) ?? 0,
        current = () => this.currentTransport(agent.id, generation);
      const recovered = await recoverSlackHistory({
        store: s,
        agentId: agent.id,
        cursorKey,
        initialOldest: oldest,
        current,
        onPage: progress,
        fetch: async (state) => {
          if (this.stopping()) throw new Error("stopping");
          const result = await client.conversations.replies({
            channel: watch.channel,
            ts: watch.thread,
            limit: 100,
            include_all_metadata: true,
            ...(state.oldest ? { oldest: state.oldest, inclusive: true } : {}),
            ...(state.cursor ? { cursor: state.cursor } : {}),
          });
          return {
            messages: result.messages ?? [],
            next: result.response_metadata?.next_cursor || undefined,
          };
        },
        timestamp: (message) => message.ts,
        ingest: (msg) => {
          if (msg.ts)
            s.ingest(
              agent.slackAppId,
              `thread-history:${watch.channel}:${msg.ts}:${msg.edited?.ts ?? msg.ts}`,
              {
                team_id: this.transport.mapper.config.teamId,
                event: {
                  ...msg,
                  type: "message",
                  channel: watch.channel,
                  thread_ts: msg.thread_ts ?? watch.thread,
                },
              },
            );
        },
      });
      if (!recovered) {
        complete = false;
        s.audit("history_gap", {
          ...watch,
          reason: "thread_history_unavailable_or_incomplete",
        });
      }
    }
    return complete;
  }
  replay(): void {
    const s = this.c.store;
    const rows = s.db
      .prepare(
        "SELECT app_id,event_id,body FROM ingress WHERE normalized=0 ORDER BY rowid LIMIT 100",
      )
      .all() as { app_id: string; event_id: string; body: string }[];
    for (const row of rows) {
      const body = JSON.parse(row.body),
        agent = this.transport.mapper.config.agents.find((a) => a.slackAppId === row.app_id);
      if (!agent) continue;
      try {
        if (body.type === "block_actions" && this.system) {
          s.atomic(() => {
            const team = body.team?.id ?? body.team_id,
              user = body.user?.id,
              channel = body.channel?.id,
              action = body.actions?.[0];
            if (
              team !== this.transport.mapper.config.teamId ||
              !/^U[A-Z0-9]+$/.test(user ?? "") ||
              !action ||
              !["mate_system_approve", "mate_system_reject"].includes(action.action_id) ||
              typeof action.value !== "string"
            )
              throw new Error("Invalid system approval interaction");
            let reply: string;
            try {
              const actor = slackPrincipal(this.transport.mapper.config, user);
              if (actor.kind !== "human") throw new Error("System approval requires a human");
              this.system!.status(agent.id, action.value);
              const result = this.system!.decide(
                this.transport.mapper.config.principalIds ? actor.id : user,
                action.value,
                action.action_id === "mate_system_approve" ? "approve" : "reject",
              );
              reply = `System request ${result.id}: ${result.status}`;
            } catch (error) {
              reply = String(error);
            }
            if (typeof channel === "string" && /^[CDG][A-Z0-9]+$/.test(channel))
              s.db
                .prepare(
                  "INSERT INTO admin_replies VALUES(?,?,?,?,?,'pending') ON CONFLICT DO NOTHING",
                )
                .run(
                  `${row.app_id}:${row.event_id}`,
                  agent.id,
                  channel,
                  user,
                  reply.slice(0, 15000),
                );
            s.db
              .prepare("UPDATE ingress SET normalized=1 WHERE app_id=? AND event_id=?")
              .run(row.app_id, row.event_id);
          });
        } else if (body.command === slackControlCommand) {
          s.atomic(() => {
            const team = body.team_id ?? body.team?.id,
              user = body.user_id ?? body.user?.id,
              channel = body.channel_id ?? body.channel?.id;
            if (
              team !== this.transport.mapper.config.teamId ||
              !/^U[A-Z0-9]+$/.test(user ?? "") ||
              !/^[CDG][A-Z0-9]+$/.test(channel ?? "")
            )
              throw new Error("Invalid control identity");
            let text = body.text ?? "";
            let reply: string;
            try {
              reply = formatControlReply(
                this.controls.execute(
                  this.transport.mapper.config.principalIds
                    ? (
                        slackPrincipal(this.transport.mapper.config, user) as {
                          id: string;
                        }
                      ).id
                    : user,
                  text,
                ),
              );
            } catch (error) {
              reply = String(error);
            }
            s.db
              .prepare(
                "INSERT INTO admin_replies VALUES(?,?,?,?,?,'pending') ON CONFLICT DO NOTHING",
              )
              .run(`${row.app_id}:${row.event_id}`, agent.id, channel, user, reply.slice(0, 15000));
            s.db
              .prepare("UPDATE ingress SET normalized=1 WHERE app_id=? AND event_id=?")
              .run(row.app_id, row.event_id);
          });
        } else this.ingress.replay(row.app_id, row.event_id);
      } catch (error) {
        s.atomic(() => {
          s.audit("ingress_rejected", {
            appId: row.app_id,
            eventId: row.event_id,
            error: String(error),
          });
          s.db
            .prepare("UPDATE ingress SET normalized=1 WHERE app_id=? AND event_id=?")
            .run(row.app_id, row.event_id);
        });
      }
    }
    this.ingress.bindPeerEchoes();
  }
  async flushAdmin(): Promise<void> {
    const s = this.c.store;
    for (const row of s.db
      .prepare("SELECT * FROM admin_replies WHERE state='pending' LIMIT 10")
      .all() as {
      id: string;
      agent_id: string;
      channel: string;
      user_id: string;
      text: string;
    }[]) {
      s.db
        .prepare("UPDATE admin_replies SET state='unknown' WHERE id=? AND state='pending'")
        .run(row.id);
      try {
        await this.transport.clients.get(row.agent_id)!.chat.postEphemeral({
          channel: row.channel,
          user: row.user_id,
          text: row.text,
        });
        s.db.prepare("UPDATE admin_replies SET state='sent' WHERE id=?").run(row.id);
      } catch {
        s.audit("admin_reply_unknown", { id: row.id });
      }
    }
  }
  async flushApprovals(): Promise<void> {
    if (!this.system) return;
    const rawOwner = this.transport.mapper.config.ownerUserIds.find((id) =>
      /^U[A-Z0-9]+$/.test(id),
    );
    if (!rawOwner) return;
    for (const request of this.system.pendingNotices()) {
      if (this.stopping()) return;
      let claimed = false;
      try {
        const client = this.transport.clients.get(request.agentId);
        if (!client) throw new Error("Missing Agent Slack client");
        const opened = await client.conversations.open({ users: rawOwner });
        const channel = opened.channel?.id;
        if (!channel) throw new Error("Owner DM unavailable");
        const details = JSON.stringify({
          agent: request.agentId,
          requestId: request.id,
          ...request.command,
          expires: new Date(request.expires).toISOString(),
        });
        const plain = (value: string) => ({
          type: "plain_text" as const,
          text: value,
        });
        const message = {
          channel,
          text: `System command approval requested by ${request.agentId}: ${request.id}`,
          blocks: [
            {
              type: "section",
              text: plain(`System command request\n${details}\n${mutableSystemInputsWarning}`),
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  action_id: "mate_system_approve",
                  text: plain("Approve"),
                  style: "danger",
                  value: request.id,
                  confirm: {
                    title: plain("Approve system command?"),
                    text: plain(
                      "Run this exact command request with system privileges? Invoked files and dependencies are not frozen.",
                    ),
                    confirm: plain("Approve"),
                    deny: plain("Cancel"),
                  },
                },
                {
                  type: "button",
                  action_id: "mate_system_reject",
                  text: plain("Reject"),
                  value: request.id,
                },
              ],
            },
          ],
        };
        if (!this.system.claimNotice(request.id)) continue;
        claimed = true;
        await client.chat.postMessage(message);
        this.system.settleNotice(request.id, "sent");
      } catch {
        if (claimed) this.system.settleNotice(request.id, "unknown");
      }
    }
  }
  async flushResults(): Promise<void> {
    if (!this.system) return;
    const rawOwner = this.transport.mapper.config.ownerUserIds.find((id) =>
      /^U[A-Z0-9]+$/.test(id),
    );
    if (!rawOwner) return;
    for (const request of this.system.pendingResults()) {
      if (this.stopping()) return;
      let claimed = false;
      try {
        const client = this.transport.clients.get(request.agentId);
        if (!client) throw new Error("Missing Agent Slack client");
        const opened = await client.conversations.open({ users: rawOwner });
        const channel = opened.channel?.id;
        if (!channel) throw new Error("Owner DM unavailable");
        const receipt = JSON.stringify(request.receipt);
        const text = `System request ${request.id} (${request.agentId}): ${request.status}. ${receipt.slice(0, 2000)}${receipt.length > 2000 ? " [truncated; use system-status and system-output REQUEST_ID stdout|stderr OFFSET]" : ""}`;
        if (!this.system.claimResultNotice(request.id)) continue;
        claimed = true;
        await client.chat.postMessage({ channel, text });
        this.system.settleResultNotice(request.id, "sent");
      } catch {
        if (claimed) this.system.settleResultNotice(request.id, "unknown");
      }
    }
  }
  async reconcile(now = Date.now()): Promise<void> {
    const s = this.c.store;
    const query = () =>
      s.db
        .prepare(
          "SELECT rowid seq,id,agent_id,request,created_at createdAt FROM outbox WHERE state='unknown' AND rowid>? ORDER BY rowid LIMIT 4",
        )
        .all(this.reconcileAfter) as {
        seq: number;
        id: string;
        agent_id: string;
        request: string;
        createdAt: number | null;
      }[];
    let rows = query();
    if (!rows.length && this.reconcileAfter) {
      this.reconcileAfter = 0;
      rows = query();
    }
    this.reconcileAfter = rows.at(-1)?.seq ?? 0;
    for (const row of rows) {
      const retryKey = `slack_outbox_retry_v1:${row.id}`;
      if (!slackScanDue(s, retryKey, now)) continue;
      const { artifact } = JSON.parse(row.request);
      const canonical = this.c.messages.records.targetedEffect("outbox", row.id).target;
      if (
        !this.c.messages.access(row.agent_id, canonical.conversationId) ||
        this.c.messages.references.conversation(canonical.conversationId).authority !== "external"
      )
        continue;
      const target = this.transport.mapper.target(canonical);
      try {
        const client = this.transport.clients.get(row.agent_id)!;
        if (artifact) {
          const receipt = JSON.parse(s.output(row.id)!.receipt ?? "{}");
          if (!receipt.fileId) continue;
          const result = await client.files.info({ file: receipt.fileId });
          const file = result.file;
          if (!file || !file.id || file.id !== receipt.fileId || !file.user) continue;
          for (const scope of [file.shares?.public, file.shares?.private])
            for (const share of scope?.[target.channel] ?? []) {
              if (share.ts && (target.thread ?? share.ts) === (share.thread_ts ?? share.ts)) {
                this.c.output.reconcileArtifact(
                  row.id,
                  file.id,
                  this.transport.mapper.message({
                    channel: target.channel,
                    ts: share.ts,
                    revision: share.ts,
                    user: file.user,
                    thread: share.thread_ts,
                    text: "",
                    deleted: false,
                    files: [{ id: file.id }],
                  }),
                );
                break;
              }
            }
          continue;
        }
        const outcome = await scanSlackPages<any>({
          store: s,
          key: `slack_outbox_reconcile_v1:${row.agent_id}:${row.id}`,
          maxPages: 2,
          fetch: async (cursor) => {
            const options = {
              channel: target.channel,
              limit: 100,
              include_all_metadata: true,
              ...(cursor ? { cursor } : {}),
            };
            const result = target.thread
              ? await client.conversations.replies({
                  ...options,
                  ts: target.thread,
                })
              : await client.conversations.history(options);
            return {
              messages: result.messages ?? [],
              next: result.response_metadata?.next_cursor || undefined,
            };
          },
          visit: (messages) => {
            for (const msg of messages) {
              const metadata = msg.metadata as
                | {
                    event_type?: string;
                    event_payload?: { id?: string; request_hash?: string };
                  }
                | undefined;
              if (
                msg.ts &&
                msg.user &&
                metadata?.event_type === "mate_outbox" &&
                metadata.event_payload?.id === row.id &&
                metadata.event_payload.request_hash
              ) {
                try {
                  this.c.output.confirm(row.id, metadata.event_payload.request_hash, {
                    message: this.transport.mapper.message({
                      channel: target.channel,
                      ts: msg.ts,
                      revision: msg.ts,
                      user: msg.user,
                      bot: msg.bot_id,
                      thread: msg.thread_ts,
                      text: msg.text ?? "",
                      deleted: false,
                    }),
                    receipt: { ts: msg.ts },
                  });
                  return true;
                } catch {
                  this.c.store.audit("outbox_reconciliation_evidence_rejected", {
                    outputId: row.id,
                    ts: msg.ts,
                  });
                }
              }
            }
            return false;
          },
        });
        if (outcome === "exhausted") scheduleSlackScan(s, retryKey, now + 15 * 60_000);
        else if (outcome === "found")
          s.db.prepare("DELETE FROM runtime_meta WHERE key=?").run(retryKey);
      } catch {
        /* keep unknown; never resend blindly */
      }
    }
  }
  async upload(
    request: DispatchEnvelope,
    artifact: import("../capabilities/artifacts.js").ArtifactPayload,
    prepared: (fileId: string) => void,
    beforeShare: () => boolean,
  ): Promise<{ fileId: string }> {
    const { actor: agentId, text } = request,
      target = this.transport.mapper.target(request.target);
    const client = this.transport.clients.get(agentId)!;
    const filename = artifact.filename ?? `${artifact.title.replace(/[^a-zA-Z0-9._-]/g, "_")}.txt`,
      bytes = Buffer.from(artifact.content, artifact.encoding === "base64" ? "base64" : "utf8");
    const allocated = await client.files.getUploadURLExternal({
      filename,
      length: bytes.length,
    });
    if (!allocated.file_id || !allocated.upload_url) throw new Error("Missing upload allocation");
    prepared(allocated.file_id);
    const url = new URL(allocated.upload_url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "files.slack.com" ||
      url.port ||
      url.username ||
      url.password
    )
      throw new Error("Unexpected Slack upload host");
    const response = await fetch(url, {
      method: "POST",
      body: bytes,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Slack byte upload failed");
    await response.body?.cancel();
    if (this.stopping() || !beforeShare()) throw new Error("Publication deferred before sharing");
    const result = await client.files.completeUploadExternal({
      files: [{ id: allocated.file_id, title: artifact.title }],
      channel_id: target.channel,
      ...(target.thread ? { thread_ts: target.thread } : {}),
      initial_comment: text,
    });
    if (!result.ok) throw new Error("Missing publication receipt");
    return { fileId: allocated.file_id };
  }
}
