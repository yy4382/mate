import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  configure,
  type AgentChange,
  type AgentState as DurableAgent,
  type Cursor,
  type Tx,
} from "@earendil-works/pi-durable";
import type { ModelRef } from "./models.ts";

/** The model settings every conversation of an Agent shares. */
export type AgentSettings = {
  readonly model: ModelRef;
  readonly thinkingLevel?: ModelThinkingLevel;
  readonly instructions?: string;
};

/** The change that makes a conversation's `pi.agent` hold exactly `settings`: an absent field is cleared. */
export function agentChange(settings: AgentSettings): AgentChange {
  return {
    model: settings.model,
    thinkingLevel: settings.thinkingLevel ?? null,
    instructions: settings.instructions ?? null,
  };
}

/** The settings a conversation's `pi.agent` holds. Every Agent's store is created with a model. */
export function settingsOf(agent: Readonly<DurableAgent> | undefined): AgentSettings {
  const model = agent?.model;
  if (model === undefined) throw new Error("the Agent's store holds no model");
  return {
    model: { provider: model.provider, modelId: model.modelId },
    ...(agent?.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
    ...(agent?.instructions === undefined ? {} : { instructions: agent.instructions }),
  };
}

/** Give every conversation of the Agent, the primary one and each assistant, `settings`. */
export async function configureConversations(tx: Tx, settings: AgentSettings): Promise<void> {
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanConversations({}, 100, cursor);
    for (const conversation of page.items)
      await configure(tx, conversation.id, agentChange(settings));
    cursor = page.next;
  } while (cursor !== undefined);
}
