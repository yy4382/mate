import { controlPage } from "./control-page.js";
import { z } from "zod";
import { encode } from "../storage/store.js";
import type { Projections, ProjectionBinding } from "../conversations/projections.js";
import type { ProjectionImports } from "../conversations/projection-imports.js";
import type { CanonicalSlackTransport } from "./transport.js";
import type { SlackProjectionInput } from "./projections.js";
import { slackPrincipal } from "./legacy-codec.js";
import {
  recoverSlackHistory,
  scanSlackPages,
  slackScanDue,
  scheduleSlackScan,
} from "./history-recovery.js";

const pageSchema = z
  .object({ before: z.number().int().positive().optional(), problemsOnly: z.boolean().optional() })
  .strict();
/** Owner-facing Slack wiring and bounded protocol recovery; no canonical mutation rules here. */
export class SlackProjectionService {
  private reconcileAfter = 0;
  constructor(
    readonly core: Projections,
    readonly imports: ProjectionImports,
    readonly input: SlackProjectionInput,
    readonly slack: CanonicalSlackTransport,
  ) {}
  private bindings(publishers?: ReadonlySet<string>): ProjectionBinding[] {
    return (
      this.core.messages.store.db
        .prepare(
          "SELECT id,publisher FROM projection_bindings WHERE provider='slack' AND workspace=?",
        )
        .all(this.slack.mapper.config.teamId) as { id: string; publisher: string }[]
    )
      .filter((row) => !publishers || publishers.has(row.publisher))
      .map((row) => this.core.binding(row.id));
  }
  /** Controls verifies owner before invoking this callback. Still verify here for direct use. */
  control(
    user: string,
    command: string,
    id: string | undefined,
    args: string[],
  ): string | undefined {
    if (
      !this.slack.mapper.config.ownerUserIds.some(
        (raw) => (this.slack.mapper.config.principalIds?.[raw] ?? raw) === user,
      )
    )
      throw new Error("Owner only");
    const s = this.core.messages.store;
    if (command === "conversations" || command === "projection-bindings") {
      const options = pageSchema.parse(id ? JSON.parse([id, ...args].join(" ")) : {});
      if (command === "conversations")
        return controlPage(
          s.db
            .prepare(
              "SELECT rowid cursor,id,kind,authority FROM conversation_identities WHERE rowid<? ORDER BY rowid DESC LIMIT 21",
            )
            .all(options.before ?? Number.MAX_SAFE_INTEGER) as { cursor: number }[],
        );
      const rows = s.db
        .prepare(
          "SELECT p.rowid cursor,p.id,b.conversation_id conversationId,p.external_id channel,p.publisher,p.enabled,json_array_length(p.imports) importMembers FROM projection_bindings p JOIN conversation_bindings b USING(provider,workspace,external_id) WHERE p.provider='slack' AND p.workspace=? AND p.rowid<? ORDER BY p.rowid DESC LIMIT 21",
        )
        .all(this.slack.mapper.config.teamId, options.before ?? Number.MAX_SAFE_INTEGER) as {
        cursor: number;
      }[];
      return controlPage(rows);
    }
    if (!command.startsWith("projection") && command !== "projections") return undefined;
    if (!id) throw new Error("Conversation or binding ID required");
    if (command === "projection-add") {
      const request = z
        .object({
          channel: z.string().regex(/^[CDG][A-Z0-9]+$/),
          publisher: z.string(),
          importUsers: z.array(z.string().regex(/^U[A-Z0-9]+$/)).default([]),
          disclose: z.literal(true),
        })
        .strict()
        .parse(JSON.parse(args.join(" ")));
      return s.atomic(() => {
        const principals = request.importUsers.map((raw) =>
          slackPrincipal(this.slack.mapper.config, raw),
        );
        for (const p of principals) {
          if (p.kind !== "human") throw new Error("importUsers must identify humans");
          s.db
            .prepare("INSERT INTO internal_members VALUES(?,'human',?) ON CONFLICT DO NOTHING")
            .run(id, p.id);
        }
        const bindingId = this.core.configure(
          id,
          {
            provider: "slack",
            workspace: this.slack.mapper.config.teamId,
            externalId: request.channel,
          },
          request.publisher,
          principals,
          true,
        );
        return encode({
          bindingId,
          disclosure:
            "Future messages only. Invite the publisher bot after binding a fresh channel.",
        });
      });
    }
    if (command === "projection-enable") {
      this.core.binding(id);
      if (!["true", "false"].includes(args[0] ?? "")) throw new Error("Expected true or false");
      this.core.setEnabled(id, args[0] === "true");
      return "Projection binding updated";
    }
    if (command === "projection-anchor") {
      if (!args[0]) throw new Error("Root message ID required");
      return encode({ projectionId: this.core.anchor(id, args[0]) });
    }
    if (command === "projections") {
      this.core.messages.references.conversation(id);
      const options = pageSchema.parse(args.length ? JSON.parse(args.join(" ")) : {});
      const rows = s.db
        .prepare(
          "SELECT p.rowid cursor,p.id,p.binding_id bindingId,p.message_id messageId,p.state,p.reason,p.drift FROM projection_outbox p JOIN message_identities m ON m.id=p.message_id WHERE m.conversation_id=? AND p.rowid<? AND (?=0 OR p.state IN ('held','unknown','failed') OR p.drift IS NOT NULL) ORDER BY p.rowid DESC LIMIT 21",
        )
        .all(
          id,
          options.before ?? Number.MAX_SAFE_INTEGER,
          Number(options.problemsOnly ?? false),
        ) as { cursor: number }[];
      return controlPage(rows);
    }
    if (command === "projection-inputs") {
      this.core.binding(id);
      const options = pageSchema.parse(args.length ? JSON.parse(args.join(" ")) : {});
      const rows = s.db
        .prepare(
          "SELECT rowid cursor,external_id externalId,external_revision revision,status,reason FROM projection_imports WHERE binding_id=? AND status!='applied' AND rowid<? ORDER BY rowid DESC LIMIT 21",
        )
        .all(id, options.before ?? Number.MAX_SAFE_INTEGER) as { cursor: number }[];
      return controlPage(rows);
    }
    throw new Error("Unknown projection command");
  }
  async reconcile(now = Date.now()): Promise<void> {
    const s = this.core.messages.store;
    const query = () =>
      s.db
        .prepare(
          "SELECT rowid seq,id,binding_id,wire FROM projection_outbox WHERE state='unknown' AND rowid>? ORDER BY rowid LIMIT 4",
        )
        .all(this.reconcileAfter) as {
        seq: number;
        id: string;
        binding_id: string;
        wire: string;
      }[];
    let rows = query();
    if (!rows.length && this.reconcileAfter) {
      this.reconcileAfter = 0;
      rows = query();
    }
    this.reconcileAfter = rows.at(-1)?.seq ?? 0;
    for (const row of rows) {
      const retryKey = `slack_projection_retry_v1:${row.id}`;
      if (!slackScanDue(s, retryKey, now)) continue;
      const b = this.core.binding(row.binding_id),
        wire = JSON.parse(row.wire),
        client = this.slack.clients.get(b.publisher);
      if (b.provider !== "slack" || b.workspace !== this.slack.mapper.config.teamId || !client)
        continue;
      try {
        const outcome = await scanSlackPages<any>({
          store: s,
          key: `slack_projection_reconcile_v1:${row.id}`,
          maxPages: 2,
          fetch: async (cursor) => {
            const args = {
              channel: b.externalId,
              limit: 100,
              include_all_metadata: true,
              oldest: String(b.createdAt / 1000),
              inclusive: true,
              ...(cursor ? { cursor } : {}),
            };
            const response = wire.thread
              ? await client.conversations.replies({ ...args, ts: wire.thread })
              : await client.conversations.history(args);
            return {
              messages: response.messages ?? [],
              next: response.response_metadata?.next_cursor || undefined,
            };
          },
          visit: (messages) => {
            for (const message of messages) {
              if (message.ts)
                this.input.handle({ ...message, type: "message", channel: b.externalId });
              if (this.core.get(row.id).state !== "unknown") return true;
            }
            return false;
          },
        });
        if (outcome === "exhausted") scheduleSlackScan(s, retryKey, now + 15 * 60_000);
        else if (outcome === "found")
          s.db.prepare("DELETE FROM runtime_meta WHERE key=?").run(retryKey);
      } catch {
        s.audit("projection_reconciliation_unavailable", {
          projectionId: row.id,
          reason: "durable_page_retained",
        });
      }
    }
  }
  private async history(
    b: ProjectionBinding,
    thread?: string,
    progress?: () => void,
  ): Promise<boolean> {
    const s = this.core.messages.store,
      client = this.slack.clients.get(b.publisher),
      installation = this.slack.mapper.config.agents.find((a) => a.id === b.publisher);
    if (!client || !installation) return false;
    const cursorKey = `projection:${b.id}:${thread ?? "top"}`;
    const saved = s.db
      .prepare("SELECT ts FROM slack_cursors WHERE agent_id=? AND channel=?")
      .get(b.publisher, cursorKey) as { ts: string } | undefined;
    const recovered = await recoverSlackHistory({
      store: s,
      agentId: b.publisher,
      cursorKey,
      initialOldest: saved?.ts ?? String(b.createdAt / 1000),
      onPage: progress,
      fetch: async (state) => {
        const args = {
          channel: b.externalId,
          limit: 100,
          include_all_metadata: true,
          ...(state.oldest ? { oldest: state.oldest, inclusive: true } : {}),
          ...(state.cursor ? { cursor: state.cursor } : {}),
        };
        const response = thread
          ? await client.conversations.replies({ ...args, ts: thread })
          : await client.conversations.history(args);
        return {
          messages: response.messages ?? [],
          next: response.response_metadata?.next_cursor || undefined,
        };
      },
      timestamp: (message) => message.ts,
      ingest: (message) => {
        if (message.ts)
          s.ingest(
            installation.slackAppId,
            `projection-history:${b.id}:${message.ts}:${message.edited?.ts ?? message.ts}`,
            {
              team_id: this.slack.mapper.config.teamId,
              event: {
                ...message,
                type: "message",
                channel: b.externalId,
                ...(thread ? { thread_ts: thread } : {}),
              },
            },
          );
      },
    });
    if (!recovered)
      s.audit("projection_history_gap", {
        bindingId: b.id,
        thread,
        reason: "history_unavailable_or_incomplete",
      });
    return recovered;
  }
  async catchUp(progress?: () => void, publishers?: ReadonlySet<string>): Promise<boolean> {
    let complete = true;
    for (const b of this.bindings(publishers))
      if (b.enabled && !(await this.history(b, undefined, progress))) complete = false;
    // Startup must cover every known root; per-thread watermarks make repeats cheap.
    const s = this.core.messages.store;
    const roots = (
      s.db
        .prepare(
          "SELECT p.id,p.publisher,mb.external_message root FROM message_bindings mb JOIN message_identities m ON m.id=mb.message_id AND m.root_id=m.id JOIN projection_bindings p ON p.provider=mb.provider AND p.workspace=mb.workspace AND p.external_id=mb.external_conversation WHERE p.enabled=1 AND p.provider='slack' AND p.workspace=? ORDER BY mb.rowid",
        )
        .all(this.slack.mapper.config.teamId) as {
        id: string;
        publisher: string;
        root: string;
      }[]
    ).filter((row) => !publishers || publishers.has(row.publisher));
    for (const root of roots)
      if (!(await this.history(this.core.binding(root.id), root.root, progress))) complete = false;
    return complete;
  }
}
