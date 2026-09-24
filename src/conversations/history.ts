import { z } from "zod";
import { hash, encode, type RunToken } from "../storage/store.js";
import { conversationTargetSchema, type ConversationTarget } from "../domain/conversations.js";
import { principalSchema, parseMessage, type MessageDTO } from "../domain/messages.js";
import type { Conversations } from "./messages.js";
const id = z.string().min(1).max(1000),
  limit = z.number().int().min(1).max(100).default(20),
  cursor = z.string().max(20000).optional();
export const historySchemas = {
  "history.page": z
    .object({
      target: conversationTargetSchema,
      limit,
      cursor,
      before: id.optional(),
      after: id.optional(),
    })
    .strict(),
  "history.search": z
    .object({
      query: z.string().min(1).max(1000),
      target: conversationTargetSchema.optional(),
      author: principalSchema.optional(),
      limit,
      cursor,
    })
    .strict(),
  // `before`/`after` are the context widths of the first call. A continuation pages one
  // direction away from the anchor, so those widths stop describing the requested page.
  "history.around": z
    .object({
      messageId: id,
      before: z.number().int().min(0).max(50).default(10),
      after: z.number().int().min(0).max(50).default(10),
      limit,
      cursor,
      direction: z.enum(["before", "after"]).optional(),
    })
    .strict(),
  "history.fetch": z
    .object({
      target: conversationTargetSchema,
      limit,
      cursor,
      before: id.optional(),
      after: id.optional(),
    })
    .strict(),
};
export interface HistoryRange {
  limit: number;
  before?: string;
  after?: string;
  cursor?: string;
}
export interface SourcePage {
  messages: MessageDTO[];
  nextCursor: string | null;
  exhausted: boolean;
  scope: string;
  gaps: string[];
  available: boolean;
}
/**
 * Why a local read of one target still waits for its adapter's coverage. The adapter owns the
 * platform fact; the core only decides that a local view may not be presented as current while
 * that target's history has not been caught up.
 */
export interface LocalCoveragePort {
  coverageWait(actor: string, conversationId: string): Error | undefined;
}
/** Adapter verifies the acting installation. Canonical IDs and a fenced run cross this port. */
export interface HistorySource {
  fetch(
    run: RunToken,
    target: ConversationTarget,
    range: HistoryRange,
    signal: AbortSignal,
  ): Promise<SourcePage>;
}
interface Position {
  channel: string;
  order: string;
  id: string;
}
/** A continuation walks away from one anchor in exactly one of these directions. */
type Direction = "before" | "after";
interface Query {
  target?: ConversationTarget | undefined;
  limit: number;
  cursor?: string | undefined;
  before?: string | undefined;
  after?: string | undefined;
  query?: string | undefined;
  author?: z.infer<typeof principalSchema> | undefined;
}
interface Cursor {
  key: string;
  position?: Position | undefined;
  remote?: string | undefined;
}
export class ConversationHistory {
  constructor(
    readonly messages: Conversations,
    readonly source?: HistorySource,
    /** Local coverage of one external target; absent means nothing waits. */
    readonly coverage?: LocalCoveragePort,
  ) {}
  /**
   * A local page may only describe the target once that target's history was caught up. Remote
   * acquisition is not gated here: fetching is how the caller completes that coverage.
   */
  private requireCoverage(run: RunToken, target?: ConversationTarget): void {
    if (!target || !this.coverage) return;
    if (this.messages.references.conversation(target.conversationId).authority !== "external")
      return;
    const waiting = this.coverage.coverageWait(run.agentId, target.conversationId);
    if (waiting) throw waiting;
  }
  /** Identity and target visibility the owning module applies to one history request. */
  authorize(run: RunToken, target?: ConversationTarget): void {
    const m = this.messages;
    m.store.assertRun(run);
    m.requireReadable(run.agentId);
    if (target) {
      m.references.validateTarget(target);
      m.requireAccess(run.agentId, target.conversationId);
      const room = m.references.conversation(target.conversationId);
      if (room.authority === "internal" && room.kind === "dm") {
        const pair = m.store.db
          .prepare("SELECT pair FROM internal_dm_pairs WHERE conversation_id=?")
          .get(room.id) as { pair: string } | undefined;
        if (!pair || !(JSON.parse(pair.pair) as string[]).includes(run.agentId))
          throw new Error("Private DM history denied");
      }
    }
  }
  private authorizedMessage(run: RunToken, id: string): MessageDTO {
    const m = this.messages,
      message = m.records.message(id);
    if (!message) throw new Error("Message not found");
    this.authorize(run, { conversationId: message.conversationId });
    const room = m.references.conversation(message.conversationId);
    if (room.authority === "internal" && room.kind === "channel") return message;
    return m.message(run.agentId, id);
  }
  private key(run: RunToken, operation: string, input: Query): string {
    // `cursor` continues one page; every other field, including `limit`, is part of the query.
    const { cursor: _, ...rest } = input;
    return hash(
      encode({
        actor: run.agentId,
        operation,
        query: rest,
        order: "conversation_then_order_desc_id_desc",
      }),
    );
  }
  /**
   * A continuation pages one direction away from one anchor, so it carries both. A cursor
   * only continues the directed walk, where the anchor and direction are the caller's to
   * repeat; `around` refuses to hand a two-sided page off as if it were such a walk.
   */
  private aroundKey(
    run: RunToken,
    anchor: string,
    direction: Direction,
    position?: Position,
  ): string {
    return hash(
      encode({
        actor: run.agentId,
        operation: "around",
        anchor,
        direction,
        ...(position ? { position } : {}),
        order: "conversation_then_order_desc_id_desc",
      }),
    );
  }
  private decode(
    value: string | undefined,
    key: string,
    owner = "another actor, target or query",
  ): Cursor | undefined {
    if (!value) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    } catch {
      throw new Error("Invalid history cursor");
    }
    const result = z
      .object({
        key: z.string(),
        position: z
          .object({ channel: id, order: z.string().regex(/^(0|[1-9][0-9]*)$/), id })
          .strict()
          .optional(),
        remote: z.string().optional(),
      })
      .strict()
      .parse(parsed);
    if (result.key !== key) throw new Error(`History cursor belongs to ${owner}`);
    return result;
  }
  private cursor(value: Cursor): string {
    return Buffer.from(encode(value)).toString("base64url");
  }
  /** Current permission decides one message's visibility, freshly per query. */
  private visibleRow(run: RunToken, channel: string, key: string): MessageDTO | undefined {
    return this.messages.store.db
      .prepare(
        `SELECT m.key FROM messages m JOIN conversation_identities c ON c.id=m.channel LEFT JOIN message_visibility v ON v.key=m.key AND v.agent_id=? WHERE m.channel=? AND m.key=? AND ((c.authority='internal' AND c.kind='channel') OR v.key IS NOT NULL)`,
      )
      .get(run.agentId, channel, key)
      ? this.authorizedMessage(run, key)
      : undefined;
  }
  /** The row that names where the next page in this direction resumes. */
  private boundary(run: RunToken, input: Query, id: string | undefined): MessageDTO | undefined {
    if (!id) return;
    const message = this.authorizedMessage(run, id);
    if (
      input.target &&
      (message.conversationId !== input.target.conversationId ||
        (input.target.threadId && message.rootId !== input.target.threadId))
    )
      throw new Error("History anchor belongs to another target");
    return message;
  }
  private query(run: RunToken, input: Query, operation: string) {
    this.authorize(run, input.target);
    this.requireCoverage(run, input.target);
    const key = this.key(run, operation, input),
      position = this.decode(input.cursor, key)?.position;
    const before = this.boundary(run, input, input.before),
      after = this.boundary(run, input, input.after),
      m = this.messages;
    const less =
      "(length(m.ts)<length(?) OR (length(m.ts)=length(?) AND (m.ts<? OR (m.ts=? AND m.key<?))))";
    const greater =
      "(length(m.ts)>length(?) OR (length(m.ts)=length(?) AND (m.ts>? OR (m.ts=? AND m.key>?))))";
    let rows: { key: string; channel: string; ts: string }[] = [];
    if (input.target) {
      const clauses = [
        "a.agent_id=? AND a.active=1",
        "((c.authority='internal' AND c.kind='channel') OR v.key IS NOT NULL)",
        "m.channel=?",
      ];
      const params: (string | number)[] = [run.agentId, input.target.conversationId];
      if (input.target.threadId) {
        clauses.push("m.thread=?");
        params.push(input.target.threadId);
      }
      for (const [bound, predicate] of [
        [before, less],
        [after, greater],
      ] as const)
        if (bound) {
          clauses.push(predicate);
          params.push(bound.order, bound.order, bound.order, bound.order, bound.id);
        }
      if (position) {
        clauses.push(less);
        params.push(position.order, position.order, position.order, position.order, position.id);
      }
      const index = input.target.threadId
        ? "message_history_thread"
        : "message_history_conversation";
      rows = m.store.db
        .prepare(
          `SELECT m.key,m.channel,m.ts FROM messages m INDEXED BY ${index} JOIN conversation_identities c ON c.id=m.channel JOIN channel_access a ON a.channel=m.channel LEFT JOIN message_visibility v ON v.key=m.key AND v.agent_id=a.agent_id WHERE ${clauses.join(" AND ")} ORDER BY m.channel,length(m.ts) DESC,m.ts DESC,m.key DESC LIMIT 1001`,
        )
        .all(...params) as typeof rows;
    } else {
      // A cross-conversation JOIN makes SQLite sort every authorized candidate in
      // a temporary B-tree. Walk the channel_access primary key and run one bounded
      // index range per channel so message work and memory stay within 1001 rows.
      const channels = m.store.db
        .prepare(
          "SELECT channel FROM channel_access WHERE agent_id=? AND active=1 AND (? IS NULL OR channel>=?) ORDER BY channel",
        )
        .iterate(
          run.agentId,
          position?.channel ?? null,
          position?.channel ?? null,
        ) as IterableIterator<{ channel: string }>;
      for (const { channel } of channels) {
        const clauses = [
          "m.channel=?",
          "((c.authority='internal' AND c.kind='channel') OR v.key IS NOT NULL)",
        ];
        const params: (string | number)[] = [run.agentId, channel];
        if (position?.channel === channel) {
          clauses.push(less);
          params.push(position.order, position.order, position.order, position.order, position.id);
        }
        params.push(1001 - rows.length);
        const page = m.store.db
          .prepare(
            `SELECT m.key,m.channel,m.ts FROM messages m INDEXED BY message_history_conversation JOIN conversation_identities c ON c.id=m.channel LEFT JOIN message_visibility v ON v.key=m.key AND v.agent_id=? WHERE ${clauses.join(" AND ")} ORDER BY m.channel,length(m.ts) DESC,m.ts DESC,m.key DESC LIMIT ?`,
          )
          .all(...params) as typeof rows;
        rows.push(...page);
        if (rows.length === 1001) break;
      }
    }
    const results: MessageDTO[] = [];
    let scanned = 0,
      more = false,
      last: Position | undefined;
    for (const row of rows) {
      if (scanned === 1000) {
        // This row is left for the continuation, so the page it opens still has results.
        more = true;
        break;
      }
      scanned++;
      // Record the boundary before filtering: a page that matched nothing still has to
      // name where the next page resumes, or it would read as the end of the history.
      last = { channel: row.channel, order: row.ts, id: row.key };
      const message = this.authorizedMessage(run, row.key);
      if (message.deleted) continue;
      if (input.author && encode(message.author) !== encode(input.author)) continue;
      if (
        input.query &&
        !message.text.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())
      )
        continue;
      // Current internal room permission includes history, without inventing new work.
      if (m.references.conversation(message.conversationId).authority === "internal")
        m.recordHistory(message, [run.agentId]);
      results.push(message);
      if (results.length === input.limit) {
        more = true;
        break;
      }
    }
    // Ending exactly on the last row leaves nothing for a continuation to open.
    if (results.length === input.limit && rows.length === scanned) more = false;
    return {
      messages: results,
      nextCursor: more && last ? this.cursor({ key, position: last }) : null,
      coverage: {
        source: "local_visible",
        scope: input.target ?? "current_authorized_conversations",
        exhausted: !more,
        scanLimited: more && scanned === 1000,
        scanned,
        live: true,
        order: "conversation_then_order_desc_id_desc",
        remoteComplete: false,
      },
    };
  }
  /**
   * Named schema fields: each one is read here, so renaming or deleting it in `historySchemas`
   * breaks this translation instead of silently dropping the bound it carried.
   */
  page(run: RunToken, value: unknown) {
    const input: z.output<(typeof historySchemas)["history.page"]> =
      historySchemas["history.page"].parse(value);
    return this.query(
      run,
      {
        target: input.target,
        limit: input.limit,
        cursor: input.cursor,
        before: input.before,
        after: input.after,
      },
      "page",
    );
  }
  search(run: RunToken, value: unknown) {
    const input: z.output<(typeof historySchemas)["history.search"]> =
      historySchemas["history.search"].parse(value);
    return this.query(
      run,
      {
        target: input.target,
        limit: input.limit,
        cursor: input.cursor,
        query: input.query,
        author: input.author,
      },
      "search",
    );
  }
  /**
   * The first call reads the nearest context on the widths the caller asked for. Supplying
   * `direction` (before or after) instead asks for a bounded, resumable walk away from the
   * anchor: a page that returns nothing still names where the next one resumes, so an empty
   * page never reads as the end of the conversation.
   */
  around(run: RunToken, value: unknown) {
    // A private DM anchor is still gated by identity, readability and the run fence.
    this.authorize(run);
    const input: z.output<(typeof historySchemas)["history.around"]> =
        historySchemas["history.around"].parse(value),
      m = this.messages,
      anchor = this.authorizedMessage(run, input.messageId),
      target: ConversationTarget = {
        conversationId: anchor.conversationId,
        ...(anchor.rootId && anchor.rootId !== anchor.id ? { threadId: anchor.rootId } : {}),
      };
    // A two-sided read only reports what each direction holds; a continuation is a directed
    // walk, so it names its direction and the two-sided read hands no cursor off.
    if (input.cursor && !input.direction)
      throw new Error("A history walk continuation needs its direction");
    const direction: Direction = input.direction ?? "before";
    this.requireCoverage(run, target);
    const owner = this.aroundKey(run, anchor.id, direction),
      cursor = input.cursor
        ? this.decode(input.cursor, owner, "another anchor, direction or query")
        : undefined,
      // The anchor is the position of the first page; a continuation resumes from the page it returned.
      boundary: Position = cursor?.position ?? {
        channel: anchor.conversationId,
        order: anchor.order,
        id: anchor.id,
      },
      index = target.threadId ? "message_history_thread" : "message_history_conversation",
      thread = target.threadId ? "AND m.thread=?" : "",
      cache = new Map<string, MessageDTO | undefined>();
    const visible = (key: string): MessageDTO | undefined => {
      if (!cache.has(key)) cache.set(key, this.visibleRow(run, target.conversationId, key));
      return cache.get(key);
    };
    /** Walk away from the boundary, stopping at the scan bound or after the requested width. */
    const walk = (direction: Direction, want: number) => {
      if (!want)
        return { messages: [] as MessageDTO[], scanned: 0, more: false, nextCursor: null as null };
      const op = direction === "before" ? "<" : ">",
        sort = direction === "before" ? "DESC" : "ASC";
      const rows = m.store.db
        .prepare(
          `SELECT m.key,m.ts FROM messages m INDEXED BY ${index} JOIN conversation_identities c ON c.id=m.channel LEFT JOIN message_visibility v ON v.key=m.key AND v.agent_id=? WHERE m.channel=? ${thread} AND ((c.authority='internal' AND c.kind='channel') OR v.key IS NOT NULL) AND (length(m.ts)${op}length(?) OR (length(m.ts)=length(?) AND (m.ts${op}? OR (m.ts=? AND m.key${op}?)))) ORDER BY length(m.ts) ${sort},m.ts ${sort},m.key ${sort} LIMIT ?`,
        )
        .all(
          run.agentId,
          target.conversationId,
          ...(target.threadId ? [target.threadId] : []),
          boundary.order,
          boundary.order,
          boundary.order,
          boundary.order,
          boundary.id,
          1001,
        ) as { key: string; ts: string }[];
      const messages: MessageDTO[] = [];
      let examined = 0,
        more = false,
        beyond: Position | undefined;
      for (const row of rows) {
        const position: Position = { channel: target.conversationId, order: row.ts, id: row.key };
        // A continuation walks strictly beyond the last row this page examined, so a page
        // that returned nothing still advances instead of reading the same rows again.
        if (examined === 1000 || messages.length === want) {
          more = true;
          break;
        }
        examined++;
        beyond = position;
        const message = visible(row.key);
        if (!message || message.deleted) continue;
        messages.push(message);
      }
      // A page that ends exactly on the last row has nothing left for a continuation.
      if (messages.length === want && rows.length === examined) {
        more = false;
        beyond = undefined;
      }
      if (direction === "before") messages.reverse();
      return {
        messages,
        scanned: examined,
        more,
        nextCursor: more && beyond ? this.cursor({ key: owner, position: beyond }) : null,
      };
    };
    const directions: Direction[] = input.direction ? [input.direction] : ["before", "after"];
    // The first read reads both widths; a continuation walks one of them.
    const pages = directions.map((direction) => {
      const want = input.direction
          ? input.limit
          : direction === "before"
            ? input.before
            : input.after,
        page = walk(direction, want);
      return { direction, page };
    });
    const before = pages.find(({ direction }) => direction === "before"),
      after = pages.find(({ direction }) => direction === "after"),
      ordered = input.direction
        ? pages[0]!.page.messages
        : [...(before?.page.messages ?? []), anchor, ...(after?.page.messages ?? [])];

    for (const message of ordered)
      if (m.references.conversation(message.conversationId).authority === "internal")
        m.recordHistory(message, [run.agentId]);
    return {
      messages: ordered,
      anchorId: anchor.id,
      // Only a directed walk continues; the two-sided read reports truncation per direction.
      nextCursor: input.direction ? pages[0]!.page.nextCursor : null,
      coverage: {
        source: "local_visible",
        target,
        ...(input.direction
          ? {
              direction: input.direction,
              scanned: pages[0]!.page.scanned,
              scanLimited: pages[0]!.page.scanned === 1000 && pages[0]!.page.more,
            }
          : {
              beforeCount: before?.page.messages.length ?? 0,
              afterCount: after?.page.messages.length ?? 0,
              beforeTruncated: !!before?.page.more,
              afterTruncated: !!after?.page.more,
            }),
        live: true,
        remoteComplete: false,
      },
    };
  }
  async fetch(run: RunToken, value: unknown, signal: AbortSignal) {
    const input = historySchemas["history.fetch"].parse(value);
    this.authorize(run, input.target);
    signal.throwIfAborted();
    this.boundary(run, input, input.before);
    this.boundary(run, input, input.after);
    const key = this.key(run, "fetch", input),
      remote = this.decode(input.cursor, key)?.remote;
    if (
      !this.source ||
      this.messages.references.conversation(input.target.conversationId).authority !== "external"
    )
      return {
        messages: [],
        nextCursor: null,
        coverage: {
          available: false,
          source: "remote",
          exhausted: false,
          gaps: ["External history source unavailable; use local history"],
        },
      };
    const page = await this.source.fetch(
      run,
      input.target,
      {
        limit: input.limit,
        ...(input.before ? { before: input.before } : {}),
        ...(input.after ? { after: input.after } : {}),
        ...(remote ? { cursor: remote } : {}),
      },
      signal,
    );
    this.authorize(run, input.target);
    signal.throwIfAborted();
    if (page.exhausted && page.nextCursor)
      throw new Error("History source returned a continuation after exhaustion");
    return this.messages.store.atomic(() => {
      const messages: MessageDTO[] = [],
        gaps = [...page.gaps];
      for (const raw of page.messages) {
        let message: MessageDTO;
        try {
          message = parseMessage(raw);
        } catch {
          gaps.push("message_parse_failed");
          continue;
        }
        if (
          message.conversationId !== input.target.conversationId ||
          (input.target.threadId && message.rootId !== input.target.threadId)
        ) {
          gaps.push("message_outside_requested_target");
          continue;
        }
        // A global cache entry, including one with the same provider revision, may
        // come from another installation. Ingestion stores this actor's exact body.
        try {
          messages.push(
            this.messages.store.atomic(() => {
              this.messages.recordHistory(message, [run.agentId]);
              return this.messages.message(run.agentId, message.id);
            }),
          );
        } catch {
          gaps.push("message_import_failed");
        }
      }
      return {
        messages,
        nextCursor: page.nextCursor ? this.cursor({ key, remote: page.nextCursor }) : null,
        coverage: {
          available: page.available,
          source: "remote",
          scope: page.scope,
          exhausted: page.exhausted,
          gaps: [...new Set(gaps)],
          live: true,
          retention: "unknown",
          remoteComplete: false,
        },
      };
    });
  }
}
