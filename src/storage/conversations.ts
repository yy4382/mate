import { parseMessage, type MessageDTO, type CanonicalEffect } from "../domain/messages.js";
import { conversationTargetSchema, type ConversationTarget } from "../domain/conversations.js";
import type { References } from "../conversations/references.js";
import type { Store } from "./store.js";

export interface LegacyPayloadDecoder {
  target(value: unknown): ConversationTarget;
  message(body: string): MessageDTO;
  confirmedMessage?(target: unknown, receipt: unknown): string;
}

/** Persistence interpretation only. Application services must enforce actor visibility. */
export class ConversationRecords {
  constructor(
    private readonly store: Store,
    private readonly references: References,
    private readonly legacy?: LegacyPayloadDecoder,
  ) {}

  private requireLegacy(): LegacyPayloadDecoder {
    if (!this.legacy) throw new Error("Legacy adapter required");
    return this.legacy;
  }

  stored(id: string, bodyText: string): MessageDTO {
    const body = JSON.parse(bodyText);
    let message: MessageDTO;
    if (Object.hasOwn(body, "format")) {
      if (body.format !== "mate.message.v2") throw new Error("Unsupported stored message format");
      message = parseMessage(body.message);
      const identity = this.references.message(message.id);
      if (message.conversationId !== identity.conversationId || message.rootId !== identity.rootId)
        throw new Error("Stored message reference mismatch");
    } else message = this.requireLegacy().message(bodyText);
    if (message.id !== id) throw new Error("Stored message identity mismatch");
    return message;
  }
  message(id: string): MessageDTO | undefined {
    const row = this.store.db.prepare("SELECT body FROM messages WHERE key=?").get(id) as
      { body: string } | undefined;
    return row ? this.stored(id, row.body) : undefined;
  }
  revision(id: string, revision: string): MessageDTO | undefined {
    const row = this.store.db
      .prepare("SELECT body FROM message_revisions WHERE key=? AND revision=?")
      .get(id, revision) as { body: string } | undefined;
    return row ? this.stored(id, row.body) : undefined;
  }

  mutableTarget(
    type: "works" | "tasks" | "schedules" | "task_intents" | "review_seats",
    id: string,
  ): ConversationTarget {
    const key = type === "review_seats" ? "agent_id" : "id";
    const row = this.store.db.prepare(`SELECT target FROM ${type} WHERE ${key}=?`).get(id) as
      { target: string } | undefined;
    if (!row) throw new Error("Target object missing");
    const marker = this.store.db
      .prepare("SELECT value FROM runtime_meta WHERE key='conversation_format'")
      .get() as { value: string } | undefined;
    if (marker?.value !== "mate.conversations.v2")
      throw new Error("Unsupported conversation data format");
    return this.checkedTarget(type, id, JSON.parse(row.target), true);
  }

  /** Only effects with an explicit conversation target; not an action authorization API. */
  targetedEffect(type: "outbox" | "actions", id: string): CanonicalEffect {
    const row = type === "outbox" ? this.store.output(id) : this.store.action(id);
    if (!row) throw new Error("Effect missing");
    const request = JSON.parse(row.request);
    if (Object.hasOwn(request, "format") && request.format !== "mate.effect.v2")
      throw new Error("Unsupported stored effect format");
    const storedTarget =
      type === "outbox" ? request.target : (request.args?.target ?? request.target);
    if (!storedTarget) throw new Error("Effect has no conversation target");
    return {
      id,
      actor: row.agent_id,
      state: row.state,
      target: this.checkedTarget(type, id, storedTarget, request.format === "mate.effect.v2"),
      original: { request: row.request, requestHash: row.request_hash, receipt: row.receipt },
    };
  }

  taskIntentResult(receipt: string): unknown {
    const value = JSON.parse(receipt);
    if (Object.hasOwn(value, "format")) {
      if (value.format !== "mate.task-intent.v2")
        throw new Error("Unsupported task intent receipt");
      return value.task;
    }
    // Unversioned historical intent receipts are known v1 evidence, never rewritten.
    return {
      ...value,
      target: JSON.stringify(this.requireLegacy().target(JSON.parse(value.target))),
    };
  }

  confirmedMessageId(id: string): string {
    const effect = this.targetedEffect("outbox", id);
    if (effect.state !== "sent" || !effect.original.receipt)
      throw new Error("Output is not confirmed");
    const request = JSON.parse(effect.original.request),
      receipt = JSON.parse(effect.original.receipt);
    const messageId =
      request.format === "mate.effect.v2"
        ? receipt.messageId
        : this.requireLegacy().confirmedMessage?.(request.target, receipt);
    if (typeof messageId !== "string") throw new Error("Confirmed message identity missing");
    const identity = this.references.message(messageId);
    if (
      identity.conversationId !== effect.target.conversationId ||
      identity.rootId !== (effect.target.threadId ?? messageId)
    )
      throw new Error("Confirmed message location mismatch");
    return messageId;
  }

  private checkedTarget(
    type: string,
    id: string,
    stored: unknown,
    canonical = false,
  ): ConversationTarget {
    const decoded = canonical
      ? this.references.validateTarget(conversationTargetSchema.parse(stored))
      : this.requireLegacy().target(stored);
    // An output keeps its original request bytes and its routing target in the same
    // row; the two must still describe the same conversation.
    if (type !== "outbox" || !canonical) return decoded;
    const row = this.store.db.prepare("SELECT target FROM outbox WHERE id=?").get(id) as {
      target: string;
    };
    const routing = this.references.validateTarget(
      conversationTargetSchema.parse(JSON.parse(row.target)),
    );
    if (routing.conversationId !== decoded.conversationId || routing.threadId !== decoded.threadId)
      throw new Error("Output routing target mismatch");
    return decoded;
  }
}
