/** Synthetic Slack fixtures translated through the production adapter into the canonical core. */
import { Conversations } from "../../src/conversations/messages.js";
import { CanonicalOutput, type ExternalMessageTransport } from "../../src/conversations/output.js";
import type {
  ArtifactTransportProvider,
  CanonicalArtifactTransport,
} from "../../src/conversations/output.js";
import type { CanonicalFreshnessGate } from "../../src/conversations/freshness.js";
import { slackApplication } from "../../src/slack/application.js";
import { CanonicalSlackTransport } from "../../src/slack/transport.js";
import { CanonicalSlackNormalizer } from "../../src/slack/normalize.js";
import type { Store } from "../../src/storage/store.js";
import type { MateConfig } from "../../src/config.js";
import type { MessageDTO } from "../../src/domain/messages.js";
import type { Collaboration } from "../../src/collaboration/service.js";
import { randomUUID } from "node:crypto";
/** Platform-shaped message input, the shape a Slack event carries before the adapter maps it. */
export interface PlatformMessage {
  team: string;
  channel: string;
  ts: string;
  thread: string;
  revision: string;
  text: string;
  user?: string;
  bot?: string;
  deleted: boolean;
  systemGenerated?: boolean;
  files?: {
    id: string;
    name?: string | undefined;
    title?: string | undefined;
    mimetype?: string | undefined;
    size?: number | undefined;
  }[];
}
export { conversationTargetSchema as targetSchema } from "../../src/domain/conversations.js";
export const fixtureTarget = (channel = "CTEST", ts = "100.000001") => ({
  conversationId: channel,
  threadId: JSON.stringify(["TTEST", channel, ts]),
});
export class Messages extends Conversations {
  readonly mapper: ReturnType<typeof slackApplication>["mapper"];
  output?: CanonicalOutput;
  constructor(store: Store, config: MateConfig) {
    const app = slackApplication(store, config);
    super(
      store,
      app.messages.agents,
      app.messages.references,
      app.messages.records,
      app.messages.writes,
      app.mapper,
      app.messages.matchesText,
    );
    this.mapper = app.mapper;
    // The shared fixture has two rooms and a known root in each; it grants no memberships or message visibility.
    for (const channel of ["CTEST", "CTWO"]) {
      if (
        !this.references.findConversation({
          provider: "slack",
          workspace: config.teamId,
          externalId: channel,
        })
      ) {
        this.references.createConversation("channel", "external", channel);
        this.references.bindConversation(
          { provider: "slack", workspace: config.teamId, externalId: channel },
          channel,
          "primary",
        );
        const id = JSON.stringify([config.teamId, channel, "100.000001"]);
        this.references.createMessage(channel, id);
        this.references.bindMessage(
          {
            provider: "slack",
            workspace: config.teamId,
            externalId: channel,
            messageId: "100.000001",
          },
          id,
        );
      }
    }
  }
  override record(message: MessageDTO | PlatformMessage, visibleTo: readonly string[]): void {
    if ("team" in message) {
      const { bot, systemGenerated, ...rest } = message;
      super.record(this.mapper.message({ ...rest, bot, system: systemGenerated }), visibleTo);
    } else super.record(message, visibleTo);
  }
  /**
   * A fresh synthetic message in the target's conversation, returned as the canonical message id a
   * task can be anchored to. Fixtures only: it records no external binding.
   */
  anchor(
    target: { conversationId: string; threadId?: string | undefined },
    visibleTo: readonly string[] = this.mapper.config.agents.map((agent) => agent.id),
  ): string {
    const thread = target.threadId ?? null,
      sequence = String(++anchorSequence).padStart(6, "0"),
      ts = `90000000${sequence}.000001`,
      id =
        this.references.conversation(target.conversationId).authority === "internal"
          ? `anchor:${sequence}`
          : this.mapper.messageId(target.conversationId, ts),
      order = `90000000${sequence}000001`,
      author = this.mapper.config.agents[0]!;
    this.references.createMessage(target.conversationId, id, thread ?? id);
    super.record(
      {
        id,
        conversationId: target.conversationId,
        rootId: thread ?? id,
        order,
        revision: order,
        text: `anchor ${ts}`,
        author: { kind: "agent", id: author.id },
        origin: "system",
        mentions: [],
        attachments: [],
        deleted: false,
      },
      visibleTo,
    );
    return id;
  }
  normalize(appId: string, eventId: string): void {
    if (!this.output) throw new Error("Fixture output missing");
    new CanonicalSlackNormalizer(this, this.mapper, this.output).normalize(appId, eventId);
  }
}

/**
 * A fresh synthetic message in the target's conversation, returned as the canonical message id a
 * task can be anchored to. Fixtures only: it records no external binding and wakes no Agent.
 */
export function anchorMessage(
  collaboration: Collaboration,
  target: { conversationId: string; threadId?: string | undefined },
): string {
  const conversationId = target.conversationId,
    thread = target.threadId ?? null,
    sequence = String(++anchorSequence).padStart(6, "0"),
    order = `90000000${sequence}000001`,
    id = `anchor:${order}`,
    rootId = thread ?? id;
  collaboration.messages.references.createMessage(conversationId, id, rootId);
  collaboration.messages.record(
    {
      id,
      conversationId,
      rootId,
      order,
      revision: order,
      text: `anchor ${order}`,
      author: { kind: "agent", id: collaboration.messages.agents.list()[0]!.id },
      origin: "system",
      mentions: [],
      attachments: [],
      deleted: false,
    },
    collaboration.messages.agents.list().map((agent) => agent.id),
  );
  return id;
}

/**
 * Create an anchored task in a test: the fresh synthetic message is the anchor the task owns, so
 * the fixture exercises the same rule production does instead of an unanchored task row.
 */
export function anchoredTask(
  collaboration: Collaboration,
  agentId: string,
  workId: string,
  target: { conversationId: string; threadId?: string | undefined },
  title: string,
  parentId?: string | undefined,
): string {
  return collaboration.createTask({
    agentId,
    workId,
    target: target as import("../../src/domain/conversations.js").ConversationTarget,
    title,
    ...(parentId ? { parentId } : {}),
    messageKey: anchorMessage(collaboration, target),
    pendingOutboxId: `fixture-anchor:${randomUUID()}`,
  });
}
let anchorSequence = 0;

/** Fake only the remote HTTP response; mapping, receipts and core dispatch are production code. */
export class Output extends CanonicalOutput {
  constructor(
    messages: Messages,
    transport: { post(...args: any[]): Promise<{ ts: string }> },
    clock: () => number = Date.now,
    gate?: CanonicalFreshnessGate,
    artifacts: ArtifactTransportProvider = () => undefined,
  ) {
    const boundary = new CanonicalSlackTransport(messages.store, messages.mapper, {});
    const adapter: ExternalMessageTransport = {
      matchesText: (expected, observed) => boundary.matchesText(expected, observed),
      pendingInput: (target) => boundary.pendingInput(target),
      classify: (error) => boundary.classify(error),
      post: async (request) => {
        const external = messages.mapper.target(request.target),
          receipt = await transport.post(request.actor, external, request.text, request.id);
        const actor = messages.mapper.config.agents.find((a) => a.id === request.actor)!;
        return {
          message: messages.mapper.message({
            ...external,
            ts: receipt.ts,
            revision: receipt.ts,
            text: request.text,
            user: actor.slackUserId,
            bot: actor.slackBotId,
            deleted: false,
          }),
          receipt,
        };
      },
    };
    super(messages, adapter, clock, gate, artifacts);
    messages.output = this;
  }
}

export const externalThread = (target: { threadId?: string }) =>
  target.threadId
    ? (JSON.parse(target.threadId)[2] as string)
    : (() => {
        throw new Error("Fixture requires a thread");
      })();
