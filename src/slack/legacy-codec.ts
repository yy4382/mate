import { z } from 'zod';
import { References } from '../conversations/references.js';
import type { ConversationTarget } from '../domain/conversations.js';
import type { MessageDTO, Principal } from '../domain/messages.js';
import type { MateConfig } from '../config.js';
import { encode } from '../storage/store.js';

const timestamp = z.string().regex(/^\d{1,16}\.\d{1,6}$/);
const targetSchema = z.object({ channel: z.string().regex(/^[CDG][A-Z0-9]+$/), thread: timestamp.optional() }).strict();
const messageSchema = z.object({
  team: z.string(), channel: z.string(), ts: timestamp, thread: timestamp, revision: timestamp,
  text: z.string(), deleted: z.boolean(), user: z.string().optional(), bot: z.string().optional(),
  systemGenerated: z.boolean().optional(),
  files: z.array(z.object({ id: z.string(), name: z.string().optional(), title: z.string().optional(), mimetype: z.string().optional(), size: z.number().optional() }).strict()).optional(),
}).strict();
const order = (value: string): string => {
  timestamp.parse(value); const [seconds, fraction] = value.split('.');
  return (BigInt(seconds!) * 1000000n + BigInt(fraction!.padEnd(6, '0'))).toString();
};

/** Sole translation of v1 Slack-shaped stored content to canonical application DTOs. */
export class LegacyConversationCodec {
  constructor(private readonly references: References, private readonly config: MateConfig) {}

  /** Trusted v1 write adapter. Internal IDs are never accepted as external locators. */
  ensureTarget(value: unknown): ConversationTarget {
    const old = targetSchema.parse(value);
    const locator = { provider: 'slack', workspace: this.config.teamId, externalId: old.channel };
    const existing = this.references.findConversation(locator);
    const conversationId = existing ?? old.channel;
    if (existing && (existing !== old.channel || this.references.conversation(existing).authority !== 'external')) {
      throw new Error('Legacy writer requires an external conversation with a legacy identity');
    }
    if (!existing) {
      this.references.createConversation(old.channel.startsWith('D') ? 'dm' : 'channel', 'external', conversationId);
      this.references.bindConversation(locator, conversationId, 'primary');
    }
    if (old.thread) {
      const rootLocator = { ...locator, messageId: old.thread };
      const id = this.references.findMessage(rootLocator) ?? encode([this.config.teamId, old.channel, old.thread]);
      this.references.createMessage(conversationId, id);
      this.references.bindMessage(rootLocator, id);
    }
    return this.target(old);
  }

  recordMessage(body: string): void {
    const old = messageSchema.parse(JSON.parse(body));
    if (old.team !== this.config.teamId) throw new Error('Legacy message workspace mismatch');
    const { conversationId } = this.ensureTarget({ channel: old.channel });
    const id = encode([old.team, old.channel, old.ts]);
    if (old.deleted && old.thread === old.ts) this.references.reserveMessage(conversationId, id);
    else {
      const target = this.ensureTarget({ channel: old.channel, thread: old.thread });
      this.references.createMessage(conversationId, id, target.threadId!);
    }
    this.references.bindMessage({ provider: 'slack', workspace: old.team, externalId: old.channel, messageId: old.ts }, id);
  }

  target(value: unknown): ConversationTarget {
    const old = targetSchema.parse(value);
    const conversationId = this.references.findConversation({ provider: 'slack', workspace: this.config.teamId, externalId: old.channel });
    if (!conversationId) throw new Error('Legacy conversation mapping missing');
    if (!old.thread) return { conversationId };
    const threadId = this.references.findMessage({ provider: 'slack', workspace: this.config.teamId, externalId: old.channel, messageId: old.thread });
    if (!threadId) throw new Error('Legacy thread mapping missing');
    return this.references.validateTarget({ conversationId, threadId });
  }

  private principal(user?: string, bot?: string): Principal {
    const byUser = user ? this.config.agents.find(a => a.slackUserId === user) : undefined;
    const byBot = bot ? this.config.agents.find(a => a.slackBotId === bot) : undefined;
    if (user && bot && (byUser || byBot) && byUser?.id !== byBot?.id) throw new Error('Conflicting legacy author identities');
    const agent = byUser ?? byBot;
    if (agent) return { kind: 'agent', id: agent.id };
    if (bot) return { kind: 'external', id: encode(['slack', this.config.teamId, 'bot', bot]) };
    if (user) return { kind: 'human', id: encode(['slack', this.config.teamId, 'user', user]) };
    return { kind: 'unknown' };
  }

  message(body: string): MessageDTO {
    const old = messageSchema.parse(JSON.parse(body));
    if (old.team !== this.config.teamId) throw new Error('Legacy message workspace mismatch');
    const locator = { provider: 'slack', workspace: old.team, externalId: old.channel, messageId: old.ts };
    const id = this.references.findMessage(locator);
    if (!id || id !== encode([old.team, old.channel, old.ts])) throw new Error('Legacy message mapping missing or conflicting');
    const identity = this.references.message(id);
    if (identity.conversationId !== this.references.findConversation(locator)) throw new Error('Legacy message conversation mismatch');
    // A self-thread deletion is only a fallback; all other roots are actual evidence.
    if (!(old.deleted && old.thread === old.ts)) {
      const root = this.references.findMessage({ ...locator, messageId: old.thread });
      if (!root || identity.rootId !== root) throw new Error('Legacy message thread mismatch');
    }
    return {
      id, conversationId: identity.conversationId, rootId: identity.rootId,
      author: this.principal(old.user, old.bot),
      origin: old.systemGenerated ? 'system' : 'participant',
      mentions: old.deleted ? [] : [...new Set([...old.text.matchAll(/<@(U[A-Z0-9]+)>/g)].map(match => match[1]!))].map(user => this.principal(user)),
      text: old.deleted ? '' : old.text, deleted: old.deleted,
      order: order(old.ts), revision: order(old.revision),
      attachments: (old.files ?? []).map(file => ({
        id: file.id,
        ...(file.name !== undefined ? { name: file.name } : {}),
        ...(file.title !== undefined ? { title: file.title } : {}),
        ...(file.mimetype !== undefined ? { mimetype: file.mimetype } : {}),
        ...(file.size !== undefined ? { size: file.size } : {}),
      })),
    };
  }
}
