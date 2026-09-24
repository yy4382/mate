import type { HistorySource, HistoryRange, SourcePage } from "../conversations/history.js";
import type { Conversations } from "../conversations/messages.js";
import type { RunToken } from "../storage/store.js";
import type { ConversationTarget } from "../domain/conversations.js";
import { compareMessageOrder, type MessageDTO } from "../domain/messages.js";
import type { CanonicalSlackTransport } from "./transport.js";
import { rawMessage } from "./protocol.js";
import { systemOrigin } from "./normalize.js";

export class SlackHistory implements HistorySource {
  constructor(
    readonly messages: Conversations,
    readonly transport: CanonicalSlackTransport,
  ) {}
  async fetch(
    run: RunToken,
    target: ConversationTarget,
    range: HistoryRange,
    signal: AbortSignal,
  ): Promise<SourcePage> {
    const m = this.messages,
      mapper = this.transport.mapper;
    const check = () => {
      signal.throwIfAborted();
      m.store.assertRun(run);
      m.requireReadable(run.agentId);
      m.requireAccess(run.agentId, target.conversationId);
    };
    check();
    const client = this.transport.clients.get(run.agentId),
      scope = target.threadId ? "thread" : "channel_top_level";
    const unavailable = (reason: string): SourcePage => ({
      messages: [],
      nextCursor: null,
      exhausted: false,
      scope,
      gaps: [reason],
      available: false,
    });
    if (!client) return unavailable("Agent has no Slack history installation");
    const location = mapper.target(target),
      version = m.membershipVersion(run.agentId);
    const anchor = (id: string | undefined) => {
      if (!id) return undefined;
      const message = m.message(run.agentId, id);
      if (
        message.conversationId !== target.conversationId ||
        (target.threadId && message.rootId !== target.threadId)
      )
        throw new Error("History anchor belongs to another target");
      const binding = m.references.messageBinding(
        id,
        "slack",
        mapper.config.teamId,
        location.channel,
      );
      if (!binding) throw new Error("History anchor has no platform binding");
      return binding.messageId;
    };
    const latest = anchor(range.before),
      oldest = anchor(range.after);
    try {
      const info = await client.conversations.info({
        channel: location.channel,
      });
      check();
      if (version !== m.membershipVersion(run.agentId))
        throw new Error("History membership changed");
      if (
        info.channel?.id !== location.channel ||
        info.channel.is_archived ||
        !(
          info.channel.is_member === true ||
          (location.channel.startsWith("D") && info.channel.is_im === true)
        )
      ) {
        m.membership(run.agentId, target.conversationId, false);
        throw new Error("Current platform access unavailable");
      }
      const args = {
        channel: location.channel,
        limit: range.limit,
        include_all_metadata: true,
        ...(latest ? { latest } : {}),
        ...(oldest ? { oldest } : {}),
        ...(range.cursor ? { cursor: range.cursor } : {}),
      };
      const response = location.thread
        ? await client.conversations.replies({ ...args, ts: location.thread })
        : await client.conversations.history(args);
      check();
      if (version !== m.membershipVersion(run.agentId))
        throw new Error("History membership changed");
      const gaps: string[] = [],
        messages: MessageDTO[] = [];
      for (const raw of (response.messages ?? []).slice(0, range.limit)) {
        const envelope = raw as { type?: unknown; subtype?: unknown };
        if (
          (envelope.type !== undefined && envelope.type !== "message") ||
          (envelope as { hidden?: unknown }).hidden === true ||
          envelope.subtype === "message_changed" ||
          envelope.subtype === "message_deleted" ||
          envelope.subtype === "message_replied"
        ) {
          gaps.push("unexpected_history_event");
          continue;
        }
        const parsed = rawMessage.safeParse({
          ...raw,
          type: "message",
          channel: location.channel,
        });
        if (!parsed.success || !parsed.data.ts) {
          gaps.push("unreadable_message");
          continue;
        }
        const value = parsed.data;
        if (value.thread_ts && location.thread && value.thread_ts !== location.thread) {
          gaps.push("unexpected_thread");
          continue;
        }
        try {
          const message = mapper.message({
            channel: location.channel,
            ts: value.ts!,
            revision: value.edited?.ts ?? value.ts!,
            thread: value.thread_ts ?? location.thread,
            text: value.text ?? "",
            user: value.user,
            bot: value.bot_id,
            files: value.files,
            deleted: false,
          });
          messages.push(systemOrigin(m, message, value.metadata));
        } catch {
          gaps.push("message_mapping_failed");
        }
      }
      if ((response.messages?.length ?? 0) > range.limit) gaps.push("provider_page_exceeded_limit");
      const nextCursor = response.response_metadata?.next_cursor || null;
      if (response.has_more && !nextCursor) gaps.push("provider_continuation_missing");
      messages.sort(
        (a, b) =>
          -compareMessageOrder(a.order, b.order) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
      return {
        messages,
        nextCursor,
        exhausted: !nextCursor && !response.has_more,
        scope,
        gaps,
        available: true,
      };
    } catch (error) {
      check();
      if (version !== m.membershipVersion(run.agentId))
        throw new Error("History membership changed");
      const code = (error as { data?: { error?: string } })?.data?.error;
      return unavailable(code ? `Slack history unavailable: ${code}` : "Slack history unavailable");
    }
  }
}
