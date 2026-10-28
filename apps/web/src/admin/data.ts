import { t } from "../i18n.ts";
import { useQuery } from "@tanstack/react-query";
import type { AgentView, CatalogModel, NodeStatusResult, ProviderView } from "@mate/admin";
import { get } from "../shell/api.ts";
import type { HumanView } from "../shell/humans.ts";

export type NodeView = NodeStatusResult;

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
  useQuery({ queryKey: adminKeys.humans, queryFn: () => get<HumanView[]>("/api/humans") });

/** The tokens an Agent has used so far, summed over its models. */
export function totalTokens(agent: Extract<AgentView, { usage: unknown }>): number {
  let total = 0;
  for (const usage of Object.values(agent.usage.models)) {
    const tokens = (usage as { totalTokens?: unknown }).totalTokens;
    if (typeof tokens === "number") total += tokens;
  }
  return total;
}

export function thinkingLabel(level: string): string {
  const labels: Record<string, string> = {
    off: t("thinking.off"),
    minimal: t("thinking.minimal"),
    low: t("thinking.low"),
    medium: t("thinking.medium"),
    high: t("thinking.high"),
    xhigh: t("thinking.xhigh"),
    max: t("thinking.max"),
  };
  return labels[level] ?? level;
}

export const STATE_LABEL: Record<string, string> = {
  open: t("data.running"),
  paused: t("data.paused"),
  closed: t("data.closed"),
  unreadable: t("data.unreadable"),
};
