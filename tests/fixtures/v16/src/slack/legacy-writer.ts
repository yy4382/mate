import { z } from "zod";
import { References } from "../../../../../src/conversations/references.js";
import type { ConversationTarget } from "../../../../../src/domain/conversations.js";
import type { MessageDTO, Principal } from "../../../../../src/domain/messages.js";
import type { MateConfig } from "../../../../../src/config.js";
import { encode } from "../../../../../src/storage/store.js";

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

import { LegacyConversationCodec } from "../../../../../src/slack/legacy-codec.js";
/** Frozen v16 fixture writer; production exposes only the read compatibility decoder. */
export class LegacyFixtureWriter extends LegacyConversationCodec {
  constructor(
    readonly fixtureReferences: References,
    readonly fixtureConfig: MateConfig,
  ) {
    super(fixtureReferences, fixtureConfig);
  }
  /** Trusted v1 write adapter. Internal IDs are never accepted as external locators. */
  ensureTarget(value: unknown): ConversationTarget {
    const old = targetSchema.parse(value);
    const locator = {
      provider: "slack",
      workspace: this.fixtureConfig.teamId,
      externalId: old.channel,
    };
    const existing = this.fixtureReferences.findConversation(locator);
    const conversationId = existing ?? old.channel;
    if (
      existing &&
      (existing !== old.channel ||
        this.fixtureReferences.conversation(existing).authority !== "external")
    ) {
      throw new Error("Legacy writer requires an external conversation with a legacy identity");
    }
    if (!existing) {
      this.fixtureReferences.createConversation(
        old.channel.startsWith("D") ? "dm" : "channel",
        "external",
        conversationId,
      );
      this.fixtureReferences.bindConversation(locator, conversationId, "primary");
    }
    if (old.thread) {
      const rootLocator = { ...locator, messageId: old.thread };
      const id =
        this.fixtureReferences.findMessage(rootLocator) ??
        encode([this.fixtureConfig.teamId, old.channel, old.thread]);
      this.fixtureReferences.createMessage(conversationId, id);
      this.fixtureReferences.bindMessage(rootLocator, id);
    }
    return this.target(old);
  }

  recordMessage(body: string): void {
    const old = messageSchema.parse(JSON.parse(body));
    if (old.team !== this.fixtureConfig.teamId)
      throw new Error("Legacy message workspace mismatch");
    const { conversationId } = this.ensureTarget({ channel: old.channel });
    const id = encode([old.team, old.channel, old.ts]);
    if (old.deleted && old.thread === old.ts)
      this.fixtureReferences.reserveMessage(conversationId, id);
    else {
      const target = this.ensureTarget({ channel: old.channel, thread: old.thread });
      this.fixtureReferences.createMessage(conversationId, id, target.threadId!);
    }
    this.fixtureReferences.bindMessage(
      { provider: "slack", workspace: old.team, externalId: old.channel, messageId: old.ts },
      id,
    );
  }
}
