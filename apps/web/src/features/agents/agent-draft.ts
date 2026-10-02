import type { AgentSummary } from "./agent-responses.js";

export type Draft = Pick<AgentSummary, "id" | "nodeId" | "name" | "role" | "description"> & {
  provider: string;
  modelId: string;
  initialChannelId: string;
};

export function newDraft(): Draft {
  return {
    id: crypto.randomUUID(),
    nodeId: "",
    name: "",
    role: "",
    description: "",
    provider: "openai",
    modelId: "",
    initialChannelId: "",
  };
}

export function requestFromDraft(draft: Draft) {
  return {
    id: draft.id,
    nodeId: draft.nodeId,
    name: draft.name.trim(),
    role: draft.role.trim(),
    description: draft.description.trim(),
    model: { provider: draft.provider.trim(), id: draft.modelId.trim() },
    ...(draft.initialChannelId ? { initialChannelId: draft.initialChannelId } : {}),
  };
}

export function draftFromAgent(agent: AgentSummary): Draft {
  return {
    id: agent.id,
    nodeId: agent.nodeId,
    name: agent.name,
    role: agent.role,
    description: agent.description,
    provider: agent.model.provider,
    modelId: agent.model.id,
    initialChannelId: agent.initialChannelId ?? "",
  };
}

export type AgentRequest = ReturnType<typeof requestFromDraft>;
