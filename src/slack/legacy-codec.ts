import { slackPrincipal } from "./principals.js";
import { z } from "zod";
import { References } from "../conversations/references.js";
import type { ConversationTarget } from "../domain/conversations.js";
import type { MessageDTO, Principal } from "../domain/messages.js";
import type { MateConfig } from "../config.js";
import { encode } from "../storage/store.js";

const timestamp = z.string().regex(/^\d{1,16}\.\d{1,6}$/);
const targetSchema = z
  .object({ channel: z.string().regex(/^[CDG][A-Z0-9]+$/), thread: timestamp.optional() })
  .strict();
const messageSchema = z
  .object({
    team: z.string(),
    channel: z.string(),
    ts: timestamp,
    thread: timestamp,
    revision: timestamp,
    text: z.string(),
    deleted: z.boolean(),
    user: z.string().optional(),
    bot: z.string().optional(),
    systemGenerated: z.boolean().optional(),
    files: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string().optional(),
            title: z.string().optional(),
            mimetype: z.string().optional(),
            size: z.number().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
const order = (value: string): string => {
  timestamp.parse(value);
  const [seconds, fraction] = value.split(".");
  return (BigInt(seconds!) * 1000000n + BigInt(fraction!.padEnd(6, "0"))).toString();
};

/** Sole translation of v1 Slack-shaped stored content to canonical application DTOs. */
export class LegacyConversationCodec {
  constructor(
    private readonly references: References,
    private readonly config: MateConfig,
  ) {}

  target(value: unknown): ConversationTarget {
    const old = targetSchema.parse(value);
    const conversationId = this.references.findConversation({
      provider: "slack",
      workspace: this.config.teamId,
      externalId: old.channel,
    });
    if (!conversationId) throw new Error("Legacy conversation mapping missing");
    if (!old.thread) return { conversationId };
    const threadId = this.references.findMessage({
      provider: "slack",
      workspace: this.config.teamId,
      externalId: old.channel,
      messageId: old.thread,
    });
    if (!threadId) throw new Error("Legacy thread mapping missing");
    return this.references.validateTarget({ conversationId, threadId });
  }

  confirmedMessage(target: unknown, receipt: unknown): string {
    const old = targetSchema.parse(target),
      proof = z.object({ ts: timestamp }).passthrough().parse(receipt);
    const id = this.references.findMessage({
      provider: "slack",
      workspace: this.config.teamId,
      externalId: old.channel,
      messageId: proof.ts,
    });
    if (!id) throw new Error("Legacy confirmed message mapping missing");
    return id;
  }

  message(body: string): MessageDTO {
    const old = messageSchema.parse(JSON.parse(body));
    if (old.team !== this.config.teamId) throw new Error("Legacy message workspace mismatch");
    const locator = {
      provider: "slack",
      workspace: old.team,
      externalId: old.channel,
      messageId: old.ts,
    };
    const id = this.references.findMessage(locator);
    if (!id || id !== encode([old.team, old.channel, old.ts]))
      throw new Error("Legacy message mapping missing or conflicting");
    const identity = this.references.message(id);
    if (identity.conversationId !== this.references.findConversation(locator))
      throw new Error("Legacy message conversation mismatch");
    // A self-thread deletion is only a fallback; all other roots are actual evidence.
    if (!(old.deleted && old.thread === old.ts)) {
      const root = this.references.findMessage({ ...locator, messageId: old.thread });
      if (!root || identity.rootId !== root) throw new Error("Legacy message thread mismatch");
    }
    return {
      id,
      conversationId: identity.conversationId,
      rootId: identity.rootId,
      author: slackPrincipal(this.config, old.user, old.bot),
      origin: old.systemGenerated ? "system" : "participant",
      mentions: old.deleted
        ? []
        : [...new Set([...old.text.matchAll(/<@(U[A-Z0-9]+)>/g)].map((match) => match[1]!))].map(
            (user) => slackPrincipal(this.config, user),
          ),
      text: old.deleted ? "" : old.text,
      deleted: old.deleted,
      order: order(old.ts),
      revision: order(old.revision),
      attachments: (old.files ?? []).map((file) => ({
        id: file.id,
        ...(file.name !== undefined ? { name: file.name } : {}),
        ...(file.title !== undefined ? { title: file.title } : {}),
        ...(file.mimetype !== undefined ? { mimetype: file.mimetype } : {}),
        ...(file.size !== undefined ? { size: file.size } : {}),
      })),
    };
  }
}

export { slackPrincipal } from "./principals.js";
