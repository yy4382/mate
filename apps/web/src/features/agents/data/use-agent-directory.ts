import type { ModelCredentialSummary, ModelProviderSummary } from "@mate/protocol/owner";
import { useCallback, useEffect, useState } from "react";
import type { NodeSummary } from "../../nodes/node-responses.js";
import { readAgentDirectory } from "../agent-requests.js";
import type { AgentSummary, ChannelSummary } from "../agent-responses.js";

const directoryPollIntervalMs = 3_000;
/** Refresh the six directories together, then let the caller reconcile its form selections. */
export function useAgentDirectory(
  onRefreshed: (nodes: NodeSummary[], providers: ModelProviderSummary[]) => void,
) {
  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [invitableChannels, setInvitableChannels] = useState<ChannelSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [providers, setProviders] = useState<ModelProviderSummary[]>([]);
  const [credentials, setCredentials] = useState<ModelCredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const directory = await readAgentDirectory(signal);
        if (signal?.aborted) return;
        setNodes(directory.nodes);
        setChannels(directory.channels);
        setInvitableChannels(directory.invitableChannels);
        setAgents(directory.agents);
        setProviders(directory.providers);
        setCredentials(directory.credentials);
        onRefreshed(directory.nodes, directory.providers);
        setRefreshError(null);
      } catch (reason) {
        if (!signal?.aborted)
          setRefreshError(reason instanceof Error ? reason.message : "读取失败，请重试。");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [onRefreshed],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = window.setInterval(
      () => void refresh(controller.signal),
      directoryPollIntervalMs,
    );
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refresh]);
  function recordReturnedAgent(returnedAgent: AgentSummary) {
    setAgents((current) => [
      ...current.filter((agent) => agent.id !== returnedAgent.id),
      returnedAgent,
    ]);
  }
  return {
    nodes,
    channels,
    invitableChannels,
    agents,
    providers,
    credentials,
    loading,
    refreshError,
    refresh,
    recordReturnedAgent,
  };
}
