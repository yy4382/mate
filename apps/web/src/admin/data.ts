import { useQuery } from "@tanstack/react-query";
import type { AgentView, CatalogModel, ProviderView } from "@mate/admin";
import { get } from "../shell/api.ts";
import type { ListedHuman } from "../shell/humans.ts";

export type NodeView = { nodeId: string; online: boolean; lastConnectedAt: string | null };

export const adminKeys = {
  agents: ["admin", "agents"] as const,
  providers: ["admin", "providers"] as const,
  models: ["admin", "models"] as const,
  nodes: ["admin", "nodes"] as const,
  humans: ["admin", "humans"] as const,
};

export const useAgents = () =>
  useQuery({
    queryKey: adminKeys.agents,
    queryFn: () => get<AgentView[]>("/api/admin/agents"),
    refetchInterval: 5000,
  });

export const useProviders = () =>
  useQuery({
    queryKey: adminKeys.providers,
    queryFn: () => get<ProviderView[]>("/api/admin/providers"),
  });

export const useModels = () =>
  useQuery({
    queryKey: adminKeys.models,
    queryFn: () => get<CatalogModel[]>("/api/admin/models"),
  });

export const useNodes = (poll = false) =>
  useQuery({
    queryKey: adminKeys.nodes,
    queryFn: () => get<NodeView[]>("/api/admin/nodes"),
    ...(poll ? { refetchInterval: 3000 } : {}),
  });

export const useHumans = () =>
  useQuery({ queryKey: adminKeys.humans, queryFn: () => get<ListedHuman[]>("/api/humans") });

/** The tokens an Agent has used so far, summed over its models. */
export function totalTokens(agent: Extract<AgentView, { usage: unknown }>): number {
  let total = 0;
  for (const usage of Object.values(agent.usage.models)) {
    const tokens = (usage as { totalTokens?: unknown }).totalTokens;
    if (typeof tokens === "number") total += tokens;
  }
  return total;
}

export const STATE_LABEL: Record<string, string> = {
  open: "运行中",
  paused: "已暂停",
  closed: "已关闭",
  unreadable: "读不出",
};
