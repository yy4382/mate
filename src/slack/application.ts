import { slackTextMatches } from "./text.js";
import type { MateConfig } from "../config.js";
import type { Store } from "../storage/store.js";
import { ConfiguredAgents } from "../agents/directory.js";
import { Conversations } from "../conversations/messages.js";
import { References } from "../conversations/references.js";
import { ConversationRecords } from "../storage/conversations.js";
import { CanonicalWrites } from "../storage/conversation-writes.js";
import { LegacyConversationCodec } from "./legacy-codec.js";
import { LegacyArguments } from "./legacy-arguments.js";
import { SlackMapper } from "./mapper.js";

/** Composition only: core depends on ports, never on this adapter bootstrap. */
export function slackApplication(
  store: Store,
  config: MateConfig,
  team: import("../domain/agents.js").TeamSettings = config,
) {
  const references = new References(store),
    legacy = new LegacyConversationCodec(references, config),
    argumentsCodec = new LegacyArguments(references, config),
    mapper = new SlackMapper(references, config);
  const records = new ConversationRecords(store, references, legacy),
    writes = new CanonicalWrites(store, references, (value) => argumentsCodec.effect(value));
  const messages = new Conversations(
    store,
    new ConfiguredAgents(team.agents),
    references,
    records,
    writes,
    {
      participates: (actor, conversationId) =>
        references.conversation(conversationId).authority === "internal" ||
        mapper.participates(actor, conversationId),
    },
    slackTextMatches,
    (actor, target) => {
      if (!config.agents.some((a) => a.id === actor))
        throw new Error("Agent has no Slack installation");
      mapper.target(target);
    },
  );
  return { messages, mapper, argumentsCodec };
}
