import { z } from "zod";
import { encode } from "../storage/store.js";
import {
  compareMessageOrder,
  parseMessage,
  type MessageDTO,
  type Principal,
} from "../domain/messages.js";
import type { Collaboration } from "../collaboration/service.js";
import { InternalMessages } from "./internal.js";
import type { ProjectionBinding, Projections } from "./projections.js";

export interface ImportedMessage {
  bindingId: string;
  externalId: string;
  externalRoot: string;
  revision: string;
  order: string;
  occurredAt: number;
  author: Principal;
  text: string;
  deleted: boolean;
  mentions: Principal[];
  attachments: MessageDTO["attachments"];
}
interface ImportRow {
  binding_id: string;
  external_id: string;
  external_revision: string;
  root_external: string;
  body: string;
  status: string;
  reason: string | null;
  message_id: string | null;
}
/** Authenticated adapter input; ACL, revision, dependencies and canonical transactions live here. */
export class ProjectionImports {
  constructor(
    readonly collaboration: Collaboration,
    readonly projections: Projections,
  ) {}
  private permitted(b: ProjectionBinding, author: Principal): boolean {
    const m = this.collaboration.messages;
    if (
      !b.enabled ||
      author.kind === "unknown" ||
      !b.imports.some((p) => p.kind === author.kind && p.id === author.id)
    )
      return false;
    if (
      !m.store.db
        .prepare(
          "SELECT 1 FROM internal_members WHERE conversation_id=? AND kind=? AND principal_id=?",
        )
        .get(b.conversationId, author.kind, author.id)
    )
      return false;
    return author.kind !== "agent" || m.access(author.id, b.conversationId);
  }
  receive(input: ImportedMessage): "applied" | "pending_dependency" | "rejected" | "mirror" {
    const c = this.collaboration,
      m = c.messages,
      s = c.store,
      b = this.projections.binding(input.bindingId);
    z.number().int().nonnegative().safe().parse(input.occurredAt);
    parseMessage({
      id: input.externalId,
      conversationId: b.conversationId,
      rootId: input.externalRoot,
      author: input.author,
      origin: "participant",
      mentions: input.mentions,
      text: input.text,
      deleted: input.deleted,
      order: input.order,
      revision: input.revision,
      attachments: input.attachments,
    });
    return s.atomic(() => {
      const locator = {
        provider: b.provider,
        workspace: b.workspace,
        externalId: b.externalId,
        messageId: input.externalId,
      };
      const bound = m.references.findMessage(locator);
      if (
        bound &&
        s.db
          .prepare("SELECT 1 FROM projection_outbox WHERE binding_id=? AND message_id=?")
          .get(b.id, bound)
      ) {
        // An external mirror is never authoritative over the internal original.
        const row = s.db
          .prepare("SELECT id,wire FROM projection_outbox WHERE binding_id=? AND message_id=?")
          .get(b.id, bound) as { id: string; wire: string | null };
        const wire = row.wire ? JSON.parse(row.wire) : undefined;
        const equal =
          this.projections.transports.get(b.provider)?.matchesText ??
          ((a: string, v: string) => a === v);
        if (input.deleted || !wire || !equal(wire.text, input.text))
          s.db
            .prepare("UPDATE projection_outbox SET drift=? WHERE id=?")
            .run(input.deleted ? "external_copy_deleted" : "external_copy_changed", row.id);
        return "mirror";
      }
      const old = s.db
        .prepare("SELECT * FROM projection_imports WHERE binding_id=? AND external_id=?")
        .get(b.id, input.externalId) as ImportRow | undefined;
      if (old && compareMessageOrder(input.revision, old.external_revision) <= 0) {
        if (old.status === "pending_dependency") return this.apply(old);
        return old.status as "applied" | "rejected";
      }
      if (old) {
        const previous = JSON.parse(old.body) as ImportedMessage;
        if (input.order !== previous.order || input.externalRoot !== previous.externalRoot)
          throw new Error("Imported message location/order is immutable");
        if (input.author.kind === "unknown") input = { ...input, author: previous.author };
        else if (
          previous.author.kind !== "unknown" &&
          encode(input.author) !== encode(previous.author)
        )
          throw new Error("Imported message author is immutable");
      }
      s.db
        .prepare(
          "INSERT INTO projection_imports(binding_id,external_id,external_revision,root_external,body,status) VALUES(?,?,?,?,?,'pending_dependency') ON CONFLICT(binding_id,external_id) DO UPDATE SET external_revision=excluded.external_revision,body=excluded.body,status='pending_dependency',reason=NULL",
        )
        .run(b.id, input.externalId, input.revision, input.externalRoot, encode(input));
      return this.apply(
        s.db
          .prepare("SELECT * FROM projection_imports WHERE binding_id=? AND external_id=?")
          .get(b.id, input.externalId) as ImportRow,
      );
    });
  }
  private apply(row: ImportRow): "applied" | "pending_dependency" | "rejected" {
    const c = this.collaboration,
      m = c.messages,
      s = c.store,
      b = this.projections.binding(row.binding_id),
      input = JSON.parse(row.body) as ImportedMessage;
    const state = (
      status: "applied" | "pending_dependency" | "rejected",
      reason: string | null,
      messageId?: string,
    ) => {
      s.db
        .prepare(
          "UPDATE projection_imports SET status=?,reason=?,message_id=COALESCE(?,message_id) WHERE binding_id=? AND external_id=?",
        )
        .run(status, reason, messageId ?? null, b.id, input.externalId);
      return status;
    };
    if (!this.permitted(b, input.author)) return state("rejected", "import_access_denied");
    if (input.occurredAt < b.createdAt)
      return state("rejected", "message_precedes_disclosure_binding");
    const locator = { provider: b.provider, workspace: b.workspace, externalId: b.externalId };
    const root =
      input.externalRoot === input.externalId
        ? undefined
        : m.references.findMessage({ ...locator, messageId: input.externalRoot });
    if (input.externalRoot !== input.externalId && !root)
      return state("pending_dependency", "root_mapping_missing");
    if (root && m.references.message(root).rootId !== root)
      return state("rejected", "invalid_thread_root");
    const target = { conversationId: b.conversationId, ...(root ? { threadId: root } : {}) };
    if (row.message_id) {
      const old = m.records.message(row.message_id);
      if (!old) throw new Error("Imported canonical message missing");
      const revision = s.db
        .prepare("UPDATE internal_sequence SET value=value+1 WHERE id=1 RETURNING value")
        .safeIntegers()
        .get() as { value: bigint };
      const recipients = (
        s.db
          .prepare("SELECT agent_id FROM channel_access WHERE channel=? AND active=1")
          .all(b.conversationId) as { agent_id: string }[]
      ).map((r) => r.agent_id);
      m.record(
        {
          ...old,
          revision: String(revision.value),
          text: input.deleted ? "" : input.text,
          deleted: input.deleted,
          mentions: input.mentions,
          attachments: input.attachments,
        },
        recipients,
      );
      return state("applied", null, old.id);
    }
    const parent = root
      ? (s.db.prepare("SELECT work_id FROM message_work WHERE message_key=?").get(root) as
          { work_id: string } | undefined)
      : undefined;
    const work =
      parent?.work_id ?? c.createWork(`projection-import:${b.id}:${input.externalId}`, target);
    const message = new InternalMessages(m).ingest(
      target,
      input.author,
      input.deleted ? "" : input.text,
      work,
      {
        mentions: input.mentions,
        attachments: input.attachments,
        deleted: input.deleted,
        sourceBinding: b.id,
      },
    );
    m.references.bindMessage({ ...locator, messageId: input.externalId }, message.id);
    return state("applied", null, message.id);
  }
  replay(): void {
    const s = this.collaboration.store;
    // Only resolvable dependencies enter this batch; an old missing root cannot monopolize it.
    const rows = s.db
      .prepare(
        "SELECT i.* FROM projection_imports i JOIN projection_bindings p ON p.id=i.binding_id WHERE i.status='pending_dependency' AND (i.root_external=i.external_id OR EXISTS(SELECT 1 FROM message_bindings m WHERE m.provider=p.provider AND m.workspace=p.workspace AND m.external_conversation=p.external_id AND m.external_message=i.root_external)) LIMIT 100",
      )
      .all() as ImportRow[];
    for (const row of rows) s.atomic(() => this.apply(row));
  }
}
