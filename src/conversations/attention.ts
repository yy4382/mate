import { directRequest } from "./attention-policy.js";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { encode, type RunToken } from "../storage/store.js";
import {
  conversationTargetSchema as targetSchema,
  type ConversationTarget as Target,
} from "../domain/conversations.js";
import type { MessageDTO as NormalMessage } from "../domain/messages.js";
import type { Conversations as Messages } from "./messages.js";
import type { LocalCoveragePort } from "./history.js";
const messageKey = (message: NormalMessage) => message.id;
function revisionNumber(value: string): bigint {
  return BigInt(value);
}
interface Publication {
  kind: "artifact";
  fileId: string;
  caption: string;
  title: string;
  target: Target;
  sender: string;
  revision: number;
}
interface ViewPage {
  messages: NormalMessage[];
  publications: Publication[];
}
interface View {
  id: string;
  agent_id: string;
  session_id: string;
  epoch: number;
  target: string;
  revision: number;
  pages: string;
  complete: number;
}
export class CanonicalAttention {
  constructor(
    readonly messages: Messages,
    /** Local coverage of one external target; absent means nothing waits. */
    readonly coverage?: LocalCoveragePort,
  ) {}
  /**
   * A fresh snapshot may only be presented once its target's history was caught up, so a
   * credential minted here never describes an incomplete view. A continuation keeps reading the
   * frozen view it names; that view's own revision already decided what the caller saw.
   */
  private requireCoverage(actor: string, conversationId: string): void {
    if (!this.coverage) return;
    if (this.messages.references.conversation(conversationId).authority !== "external") return;
    const waiting = this.coverage.coverageWait(actor, conversationId);
    if (waiting) throw waiting;
  }
  /** A transport reports a source gap without teaching the core its provider. */
  recordExternalHistoryGap(actor: string, reason: string): void {
    this.messages.agent(actor);
    if (!/^[a-z][a-z0-9_]{0,100}$/.test(reason)) throw new Error("Invalid history gap reason");
    const s = this.messages.store;
    s.atomic(() => {
      s.db.prepare("UPDATE sessions SET context_epoch=context_epoch+1 WHERE agent_id=?").run(actor);
      const channels = s.db
        .prepare(
          "SELECT a.channel FROM channel_access a JOIN conversation_identities c ON c.id=a.channel WHERE a.agent_id=? AND a.active=1 AND c.authority='external'",
        )
        .all(actor) as { channel: string }[];
      for (const { channel } of channels)
        s.db
          .prepare(
            "INSERT INTO conversation_events(channel,thread,message_key,revision,kind,audience) VALUES(?,?,?,?,?,?)",
          )
          .run(channel, null, reason, String(Date.now()), "recovery_gap", actor);
    });
  }
  private epoch(session: string): number {
    return (
      this.messages.store.db
        .prepare("SELECT context_epoch FROM sessions WHERE id=?")
        .get(session) as { context_epoch: number }
    ).context_epoch;
  }
  revision(target: Target, actor?: string): number {
    targetSchema.parse(target);
    return (
      this.messages.store.db
        .prepare(
          `SELECT COALESCE(MAX(e.seq),0) revision FROM conversation_events e
      JOIN conversation_identities c ON c.id=e.channel LEFT JOIN message_visibility v ON v.key=e.message_key AND v.agent_id=?
      WHERE e.channel=? AND (? IS NULL OR e.thread=? OR (e.kind='recovery_gap' AND e.thread IS NULL)) AND (e.audience IS NULL OR e.audience=?)
      AND (? IS NULL OR c.authority='internal' OR e.kind NOT IN ('message','edit','delete','files_enriched','location_enriched','visibility') OR v.revision=e.revision)`,
        )
        .get(
          actor ?? null,
          target.conversationId,
          target.threadId ?? null,
          target.threadId ?? null,
          actor ?? null,
          actor ?? null,
        ) as { revision: number }
    ).revision;
  }
  private publications(actor: string, target?: Target): Publication[] {
    const publications: Publication[] = [];
    const rows = this.messages.store.db
      .prepare(
        `SELECT o.id,o.agent_id,o.request,o.receipt FROM outbox o
      JOIN channel_access a ON a.channel=json_extract(o.target,'$.conversationId') AND a.agent_id=? AND a.active=1
      WHERE o.state='sent' AND json_extract(o.request,'$.artifact') IS NOT NULL
      AND (? IS NULL OR json_extract(o.target,'$.conversationId')=?) AND (? IS NULL OR json_extract(o.target,'$.threadId')=?) ORDER BY o.rowid DESC`,
      )
      .iterate(
        actor,
        target?.conversationId ?? null,
        target?.conversationId ?? null,
        target?.threadId ?? null,
        target?.threadId ?? null,
      ) as IterableIterator<{ id: string; agent_id: string; request: string; receipt: string }>;
    for (const row of rows) {
      const effect = this.messages.records.targetedEffect("outbox", row.id),
        scope = effect.target;
      if (!this.messages.access(actor, scope.conversationId)) continue;
      if (
        target &&
        (target.conversationId !== scope.conversationId ||
          (target.threadId && target.threadId !== scope.threadId))
      )
        continue;
      const request = JSON.parse(row.request),
        receipt = JSON.parse(row.receipt);
      const event = this.messages.store.db
        .prepare(
          "SELECT seq FROM conversation_events WHERE message_key=? AND channel=? AND kind='artifact' ORDER BY seq DESC LIMIT 1",
        )
        .get(`artifact:${receipt.fileId}`, scope.conversationId) as { seq: number } | undefined;
      if (!event) throw new Error("Publication event missing");
      const echoed = this.messages
        .read(actor, scope)
        .some(
          (message) =>
            message.author.kind === "agent" &&
            message.author.id === row.agent_id &&
            this.messages.matchesText(request.text, message.text) &&
            message.attachments.some((file) => file.id === receipt.fileId) &&
            !!message.rootId &&
            (scope.threadId ? message.rootId === scope.threadId : message.rootId === message.id),
        );
      if (echoed) continue;
      publications.push({
        kind: "artifact",
        fileId: receipt.fileId,
        caption: request.text,
        title: request.artifact.title,
        target: scope,
        sender: row.agent_id,
        revision: event.seq,
      });
      if (publications.length === 101) break;
    }
    return publications.sort((a, b) => a.revision - b.revision);
  }
  peek(
    actor: string,
    now = Date.now(),
    scope?: Target,
  ): { target: Target; revision: number; unseen: number }[] | { isolated: true; notice: string }[] {
    if (this.messages.isolated(actor))
      return [
        { isolated: true, notice: "Independent review seat; discussion inputs are withheld." },
      ];
    const s = this.messages.store;
    this.messages.agent(actor);
    const rows = s.db
      .prepare(
        `SELECT m.channel,m.thread,m.key,o.revision observed,MAX(e.seq) seq,seen.revision seen FROM messages m
      JOIN message_visibility v ON v.key=m.key AND v.agent_id=? JOIN channel_access a ON a.agent_id=v.agent_id AND a.channel=m.channel AND a.active=1
      JOIN message_observations o ON o.agent_id=v.agent_id AND o.key=m.key
        AND NOT EXISTS(SELECT 1 FROM message_observations newer WHERE newer.agent_id=o.agent_id AND newer.key=o.key AND (length(newer.revision)>length(o.revision) OR (length(newer.revision)=length(o.revision) AND newer.revision>o.revision)))
      JOIN conversation_events e ON e.message_key=m.key AND e.revision=o.revision AND (e.audience IS NULL OR e.audience=v.agent_id)
      LEFT JOIN attention_seen seen ON seen.agent_id=v.agent_id AND seen.key=m.key
      WHERE (? IS NULL OR m.channel=?) AND (? IS NULL OR m.thread=?)
      GROUP BY m.key,o.revision`,
      )
      .all(
        actor,
        scope?.conversationId ?? null,
        scope?.conversationId ?? null,
        scope?.threadId ?? null,
        scope?.threadId ?? null,
      ) as {
      channel: string;
      thread: string | null;
      key: string;
      observed: string;
      seq: number;
      seen: string | null;
    }[];
    const groups = new Map<string, { target: Target; revision: number; unseen: number }>();
    for (const row of rows) {
      const message = this.messages.message(actor, row.key);
      if (message.author.kind === "agent" && message.author.id === actor) continue;
      const target: Target = {
          conversationId: row.channel,
          ...(row.thread ? { threadId: row.thread } : {}),
        },
        key = encode(target);
      const states = s.db
        .prepare(
          "SELECT resolved,deferred_until,muted FROM attention_state WHERE agent_id=? AND target IN (?,?)",
        )
        .all(actor, key, encode({ conversationId: row.channel })) as {
        resolved: number;
        deferred_until: number;
        muted: number;
      }[];
      const direct = directRequest(
        actor,
        message,
        this.messages.references.conversation(row.channel).kind,
      );
      if (
        states.some(
          (st) => (st.muted && !direct) || st.deferred_until > now || st.resolved >= row.seq,
        )
      )
        continue;
      const group = groups.get(key) ?? { target, revision: 0, unseen: 0 };
      group.revision = Math.max(group.revision, row.seq);
      group.unseen += Number(row.seen !== row.observed);
      groups.set(key, group);
    }
    for (const publication of this.publications(actor, scope)) {
      if (publication.sender === actor) continue;
      const target = publication.target,
        key = encode(target);
      const states = s.db
        .prepare(
          "SELECT resolved,deferred_until,muted FROM attention_state WHERE agent_id=? AND target IN (?,?)",
        )
        .all(actor, key, encode({ conversationId: target.conversationId })) as {
        resolved: number;
        deferred_until: number;
        muted: number;
      }[];
      if (
        states.some(
          (st) => st.muted || st.deferred_until > now || st.resolved >= publication.revision,
        )
      )
        continue;
      const seen = s.db
        .prepare("SELECT 1 FROM attention_seen WHERE agent_id=? AND key=? AND revision=?")
        .get(actor, `artifact:${publication.fileId}`, String(publication.revision));
      const group = groups.get(key) ?? { target, revision: 0, unseen: 0 };
      group.revision = Math.max(group.revision, publication.revision);
      group.unseen += Number(!seen);
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => b.revision - a.revision).slice(0, 50);
  }
  read(run: RunToken, target: Target, cursor?: string): unknown {
    this.messages.requireReadable(run.agentId);
    const s = this.messages.store;
    s.assertRun(run);
    targetSchema.parse(target);
    this.messages.requireAccess(run.agentId, target.conversationId);
    if (!cursor) this.requireCoverage(run.agentId, target.conversationId);
    let view: View,
      page = 0;
    if (cursor) {
      const split = cursor.split(":");
      if (split.length !== 2 || !/^\d+$/.test(split[1]!)) throw new Error("Invalid view cursor");
      const found = s.db.prepare("SELECT * FROM attention_views WHERE id=?").get(split[0]) as
        View | undefined;
      if (
        !found ||
        found.agent_id !== run.agentId ||
        found.session_id !== run.sessionId ||
        found.epoch !== this.epoch(run.sessionId) ||
        found.target !== encode(target)
      )
        throw new Error("Expired or foreign view");
      view = found;
      page = Number(split[1]);
    } else {
      const rows = s.db
        .prepare(
          "SELECT m.key FROM messages m JOIN message_visibility v ON v.key=m.key WHERE v.agent_id=? AND m.channel=? AND (? IS NULL OR m.thread=?) ORDER BY length(m.ts),m.ts LIMIT 10001",
        )
        .all(
          run.agentId,
          target.conversationId,
          target.threadId ?? null,
          target.threadId ?? null,
        ) as { key: string }[];
      const pages: NormalMessage[][] = [[]];
      let bytes = 0,
        complete = rows.length <= 10000;
      for (const row of rows.slice(0, 10000)) {
        const message = this.messages.message(run.agentId, row.key);
        if (message.deleted) message.text = "";
        if (Buffer.byteLength(encode(message)) > 120000) {
          message.text = message.text.slice(0, 25000);
          complete = false;
        }
        const size = Buffer.byteLength(encode(message));
        if (pages.at(-1)!.length && (bytes + size > 150000 || pages.at(-1)!.length >= 20)) {
          pages.push([]);
          bytes = 0;
        }
        pages.at(-1)!.push(message);
        bytes += size;
      }
      const published = this.publications(run.agentId, target),
        snapshots: ViewPage[] = pages.map((messages) => ({ messages, publications: [] }));
      if (published.length > 100) complete = false;
      let publicationBytes = 0;
      for (const publication of published.slice(-100)) {
        const size = Buffer.byteLength(encode(publication));
        if (!snapshots.at(-1)!.publications.length || publicationBytes + size > 140000) {
          snapshots.push({ messages: [], publications: [] });
          publicationBytes = 0;
        }
        snapshots.at(-1)!.publications.push(publication);
        publicationBytes += size;
      }
      view = {
        id: randomUUID(),
        agent_id: run.agentId,
        session_id: run.sessionId,
        epoch: this.epoch(run.sessionId),
        target: encode(target),
        revision: this.revision(target, run.agentId),
        pages: encode(snapshots),
        complete: Number(complete),
      };
      s.db
        .prepare("INSERT INTO attention_views VALUES(?,?,?,?,?,?,?,?)")
        .run(
          view.id,
          view.agent_id,
          view.session_id,
          view.epoch,
          view.target,
          view.revision,
          view.pages,
          view.complete,
        );
    }
    return this.response(view, page);
  }
  private response(view: View, page: number): unknown {
    const pages = JSON.parse(view.pages) as (NormalMessage[] | ViewPage)[];
    if (!Number.isSafeInteger(page) || page < 0 || page >= pages.length)
      throw new Error("Invalid view page");
    const current = pages[page]!;
    const contents = Array.isArray(current)
      ? { messages: current }
      : { messages: current.messages, publications: current.publications };
    const target = JSON.parse(view.target) as Target;
    const gaps = (
      this.messages.store.db
        .prepare(
          "SELECT DISTINCT message_key reason FROM conversation_events WHERE kind='recovery_gap' AND audience=? AND channel=? AND seq<=? AND (? IS NULL OR thread IS NULL OR thread=?)",
        )
        .all(
          view.agent_id,
          target.conversationId,
          view.revision,
          target.threadId ?? null,
          target.threadId ?? null,
        ) as { reason: string }[]
    ).map((row) => row.reason);
    return {
      viewToken: view.id,
      page,
      target,
      ...contents,
      coverage: {
        revision: view.revision,
        pageCount: pages.length,
        complete: !!view.complete,
        scope: "locally observed and visible messages",
        gaps,
      },
      nextCursor: page + 1 < pages.length ? `${view.id}:${page + 1}` : null,
    };
  }
  /** Called atomically with journal commit, never when the tool merely returns over IPC. */
  presented(run: RunToken, message: AgentMessage): void {
    if (message.role !== "toolResult" || message.isError) return;
    const content = message.content;
    if (content.length !== 1 || content[0]?.type !== "text") return;
    let result: any;
    try {
      result = JSON.parse(content[0].text);
    } catch {
      return;
    }
    if (typeof result?.viewToken !== "string") return;
    const s = this.messages.store,
      view = s.db.prepare("SELECT * FROM attention_views WHERE id=?").get(result.viewToken) as
        View | undefined;
    if (
      !view ||
      view.agent_id !== run.agentId ||
      view.session_id !== run.sessionId ||
      view.epoch !== this.epoch(run.sessionId)
    )
      return;
    this.messages.requireAccess(run.agentId, JSON.parse(view.target).conversationId);
    if (encode(this.response(view, result.page)) !== content[0].text) return;
    s.db
      .prepare("INSERT INTO attention_presented VALUES(?,?) ON CONFLICT DO NOTHING")
      .run(view.id, result.page);
    // A bounded/truncated response cannot establish full message presentation.
    if (view.complete)
      for (const publication of (result.publications ?? []) as Publication[]) {
        s.db
          .prepare(
            "INSERT INTO attention_seen VALUES(?,?,?) ON CONFLICT(agent_id,key) DO UPDATE SET revision=excluded.revision",
          )
          .run(run.agentId, `artifact:${publication.fileId}`, String(publication.revision));
        // Echo can arrive either before or after the publication's journal ACK.
        const echoed = this.messages
          .read(run.agentId, publication.target)
          .filter(
            (message) =>
              message.author.kind === "agent" &&
              message.author.id === publication.sender &&
              this.messages.matchesText(publication.caption, message.text) &&
              message.attachments.length === 1 &&
              message.attachments[0]?.id === publication.fileId &&
              (publication.target.threadId
                ? message.rootId === publication.target.threadId
                : message.rootId === message.id),
          );
        for (const echo of echoed)
          s.db
            .prepare(
              "INSERT INTO attention_seen VALUES(?,?,?) ON CONFLICT(agent_id,key) DO UPDATE SET revision=excluded.revision",
            )
            .run(run.agentId, echo.id, echo.revision);
      }
    if (view.complete)
      for (const msg of result.messages as NormalMessage[]) {
        const key = messageKey(msg),
          current = this.messages.message(run.agentId, key);
        if (current && encode(current.attachments ?? []) !== encode(msg.attachments ?? []))
          continue;
        const old = s.db
          .prepare("SELECT revision FROM attention_seen WHERE agent_id=? AND key=?")
          .get(run.agentId, key) as { revision: string } | undefined;
        if (!old || revisionNumber(msg.revision) > revisionNumber(old.revision))
          s.db
            .prepare(
              "INSERT INTO attention_seen VALUES(?,?,?) ON CONFLICT(agent_id,key) DO UPDATE SET revision=excluded.revision",
            )
            .run(run.agentId, key, msg.revision);
      }
  }
  valid(run: RunToken, target: Target, token?: string): boolean {
    if (this.messages.isolated(run.agentId)) return false;
    if (!token || !this.messages.access(run.agentId, target.conversationId)) return false;
    const s = this.messages.store,
      v = s.db.prepare("SELECT * FROM attention_views WHERE id=?").get(token) as View | undefined;
    if (
      !v ||
      v.agent_id !== run.agentId ||
      v.session_id !== run.sessionId ||
      v.epoch !== this.epoch(run.sessionId) ||
      v.target !== encode(target) ||
      !v.complete ||
      v.revision !== this.revision(target, run.agentId)
    )
      return false;
    const count = (
      s.db.prepare("SELECT COUNT(*) n FROM attention_presented WHERE view_id=?").get(token) as {
        n: number;
      }
    ).n;
    return count === (JSON.parse(v.pages) as unknown[]).length;
  }
  invalidate(session: string): void {
    this.messages.store.db
      .prepare("UPDATE sessions SET context_epoch=context_epoch+1 WHERE id=?")
      .run(session);
  }
  state(
    actor: string,
    target: Target,
    operation: "resolve" | "defer" | "mute",
    value: number,
  ): void {
    targetSchema.parse(target);
    this.messages.requireAccess(actor, target.conversationId);
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      (operation === "resolve" && value > this.revision(target, actor)) ||
      (operation === "mute" && value > 1)
    )
      throw new Error("Invalid attention state");
    this.messages.store.atomic(() => {
      const s = this.messages.store,
        key = encode(target);
      s.db
        .prepare("INSERT INTO attention_state(agent_id,target) VALUES(?,?) ON CONFLICT DO NOTHING")
        .run(actor, key);
      const column =
        operation === "resolve" ? "resolved" : operation === "defer" ? "deferred_until" : "muted";
      s.db
        .prepare(`UPDATE attention_state SET ${column}=? WHERE agent_id=? AND target=?`)
        .run(value, actor, key);
    });
  }
}
