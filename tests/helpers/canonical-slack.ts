/** Synthetic Slack fixtures translated through the production adapter into the canonical core. */
import { Conversations } from "../../src/conversations/messages.js";
import { CanonicalOutput, type ExternalMessageTransport } from "../../src/conversations/output.js";
import { slackApplication } from "../../src/slack/application.js";
import { CanonicalSlackTransport } from "../../src/slack/transport.js";
import { CanonicalSlackNormalizer } from "../../src/slack/normalize.js";
import { migrateCanonicalConversations } from "../../src/slack/canonical-migration.js";
import { migrateInternalConversations } from "../../src/storage/internal-schema.js";
import { migrateProjections } from "../../src/storage/projection-schema.js";
import { migrateProjectionImports } from "../../src/storage/projection-import-schema.js";
import { migrateHistoryIndexes } from "../../src/storage/history-schema.js";
import { migrateCoordinationRecovery } from "../../src/storage/coordination-schema.js";
import { migrateOperationsView } from "../../src/storage/operations-schema.js";
import { migrateSystemOperations } from "../../src/storage/system-operations-schema.js";
import { migrateModelUsage } from "../../src/storage/model-usage-schema.js";
import type { Store } from "../../src/storage/store.js";
import type { MateConfig } from "../../src/config.js";
import type { MessageDTO } from "../../src/domain/messages.js";
import type { NormalMessage } from "../fixtures/v16/src/conversations/messages.js";
export { conversationTargetSchema as targetSchema } from "../../src/domain/conversations.js";
export const fixtureTarget = (channel = "CTEST", ts = "100.000001") => ({
  conversationId: channel,
  threadId: JSON.stringify(["TTEST", channel, ts]),
});
export class Messages extends Conversations {
  readonly mapper: ReturnType<typeof slackApplication>["mapper"];
  output?: CanonicalOutput;
  constructor(store: Store, config: MateConfig) {
    migrateCanonicalConversations(store, config);
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
  override record(message: MessageDTO | NormalMessage, visibleTo: readonly string[]): void {
    if ("team" in message) {
      const { bot, systemGenerated, ...rest } = message;
      super.record(this.mapper.message({ ...rest, bot, system: systemGenerated }), visibleTo);
    } else super.record(message, visibleTo);
  }
  normalize(appId: string, eventId: string): void {
    if (!this.output) throw new Error("Fixture output missing");
    new CanonicalSlackNormalizer(this, this.mapper, this.output).normalize(appId, eventId);
  }
}

/** Complete the explicit offline schema chain for fixtures that construct current runtime services. */
export function migrateCurrentRuntime(store: Store): void {
  migrateInternalConversations(store);
  migrateProjections(store);
  migrateProjectionImports(store);
  migrateHistoryIndexes(store);
  migrateCoordinationRecovery(store);
  migrateOperationsView(store);
  migrateSystemOperations(store);
  migrateModelUsage(store);
}
/** Fake only the remote HTTP response; mapping, receipts and core dispatch are production code. */
export class Output extends CanonicalOutput {
  constructor(
    messages: Messages,
    transport: { post(...args: any[]): Promise<{ ts: string }> },
    clock: () => number = Date.now,
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
    super(messages, adapter, clock);
    messages.output = this;
  }
}

export const externalThread = (target: { threadId?: string }) =>
  target.threadId
    ? (JSON.parse(target.threadId)[2] as string)
    : (() => {
        throw new Error("Fixture requires a thread");
      })();
