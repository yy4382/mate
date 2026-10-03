import type {
  ModelCredentialSummary as ModelCredential,
  ModelProviderSummary as ModelProvider,
} from "@mate/protocol/owner";
import { useCallback, useEffect, useState } from "react";
import { nodesResponseSchema, type NodeSummary } from "../../nodes/node-responses.js";
import { readJSON } from "../agent-requests.js";
import {
  agentsResponseSchema,
  channelsResponseSchema,
  credentialsResponseSchema,
  providersResponseSchema,
  type AgentSummary,
  type ChannelSummary,
} from "../agent-responses.js";

const directoryPollIntervalMs = 3_000;
/** Six directory results refresh together; callers retain the original draft/provider reconciliation. */
export function useAgentDirectory(
  onRefreshed: (nodes: NodeSummary[], providers: ModelProvider[]) => void,
) {
  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [invitableChannels, setInvitableChannels] = useState<ChannelSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [
          nodeResult,
          channelResult,
          invitationChannelResult,
          agentResult,
          providerResult,
          credentialResult,
        ] = await Promise.all([
          readJSON("/api/owner/nodes", nodesResponseSchema, signal),
          readJSON("/api/owner/channels", channelsResponseSchema, signal),
          readJSON("/api/owner/invitable-channels", channelsResponseSchema, signal),
          readJSON("/api/owner/agents", agentsResponseSchema, signal),
          readJSON("/api/owner/model-providers", providersResponseSchema, signal),
          readJSON("/api/owner/model-credentials", credentialsResponseSchema, signal),
        ]);
        if (signal?.aborted) return;
        setNodes(nodeResult.nodes);
        setChannels(channelResult.channels);
        setInvitableChannels(invitationChannelResult.channels);
        setAgents(agentResult.agents);
        setProviders(providerResult.providers);
        setCredentials(credentialResult.credentials);
        onRefreshed(nodeResult.nodes, providerResult.providers);
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
