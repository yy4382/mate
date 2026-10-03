import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  ModelCredentialSummary as ModelCredential,
  ModelProviderSummary as ModelProvider,
} from "@mate/protocol/owner";
import { redirectToLogin } from "../../navigation.js";
import { AgentActivity } from "./agent-activity.js";
import { agentStopStatus } from "./agent-stop-status.js";
import { AgentEditor } from "./agent-editor.js";
import {
  draftFromAgent,
  newDraft,
  requestFromDraft,
  type AgentRequest,
  type Draft,
} from "./agent-draft.js";
import { errorMessage, readJSON } from "./agent-requests.js";
import {
  agentResponseSchema,
  agentsResponseSchema,
  channelsResponseSchema,
  directChannelResponseSchema,
  providersResponseSchema,
  credentialsResponseSchema,
  type AgentSummary,
  type ChannelSummary,
} from "./agent-responses.js";
import { nodesResponseSchema, type NodeSummary } from "../nodes/node-responses.js";
import { useModelCredentials } from "./use-model-credentials.js";
import "./agents-page.css";
import { WorkspaceBrowser } from "../workspace/workspace-browser.js";

/** Refresh node/Agent/provisioning facts independently of form submissions. */
const directoryPollIntervalMs = 3_000;

const stageLabels: Record<AgentSummary["stage"], string> = {
  queued: "等待节点处理",
  checking_account: "检查运行账号",
  preparing_workspace: "准备默认工作区",
  verifying_workspace: "核验工作区与记忆入口",
  complete: "工作区与会话已核验",
  failed: "创建未完成",
};

export function AgentsPage() {
  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [invitableChannels, setInvitableChannels] = useState<ChannelSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const {
    credentialProvider,
    setCredentialProvider,
    credentialKey,
    setCredentialKey,
    credentialBusy,
    credentialError,
    credentialSaved,
    reconcileProviders,
    submitCredential,
    revokeCredential,
  } = useModelCredentials();
  const [directChannels, setDirectChannels] = useState<Record<string, string>>({});
  const [openingDirectMessage, setOpeningDirectMessage] = useState<string | null>(null);
  const [inviteChannels, setInviteChannels] = useState<Record<string, string>>({});
  const [invitingAgent, setInvitingAgent] = useState<string | null>(null);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [invitationNotice, setInvitationNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [creationError, setCreationError] = useState<string | null>(null);

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
        reconcileProviders(providerResult.providers);
        setDraft((current) => {
          const provider =
            providerResult.providers.find((candidate) => candidate.id === current.provider) ??
            providerResult.providers[0];
          const model =
            provider?.models.find((candidate) => candidate.id === current.modelId) ??
            provider?.models[0];
          return {
            ...current,
            nodeId:
              current.nodeId && nodeResult.nodes.some((node) => node.id === current.nodeId)
                ? current.nodeId
                : (nodeResult.nodes.find((node) => node.online)?.id ?? ""),
            provider: provider?.id ?? "",
            modelId: model?.id ?? "",
          };
        });
        setRefreshError(null);
      } catch (reason) {
        if (!signal?.aborted)
          setRefreshError(reason instanceof Error ? reason.message : "读取失败，请重试。");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [reconcileProviders],
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

  async function submitRequest(request: AgentRequest): Promise<void> {
    setSubmitting(true);
    setCreationError(null);
    try {
      const response = await fetch("/api/owner/agents", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const result: unknown = await response.json().catch(() => null);
      const returned = agentResponseSchema.safeParse(result);
      if (returned.success) {
        const returnedAgent = returned.data.agent;
        setAgents((current) => [
          ...current.filter((agent) => agent.id !== returnedAgent.id),
          returnedAgent,
        ]);
      }
      if (!response.ok) throw new Error(errorMessage(result, "Agent 创建失败，请按同一请求重试。"));
      await refresh();
    } catch (reason) {
      setCreationError(
        reason instanceof Error ? reason.message : "Agent 创建失败，请按同一请求重试。",
      );
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitRequest(requestFromDraft(draft));
  }

  async function openDirectMessage(agentId: string) {
    setOpeningDirectMessage(agentId);
    setCreationError(null);
    try {
      const response = await fetch(
        `/api/owner/agents/${encodeURIComponent(agentId)}/direct-channel`,
        {
          method: "POST",
          headers: { Accept: "application/json" },
        },
      );
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(result, "暂时无法打开私信。"));
      const parsed = directChannelResponseSchema.safeParse(result);
      if (!parsed.success) throw new Error("暂时无法打开私信。");
      setDirectChannels((current) => ({ ...current, [agentId]: parsed.data.channel.id }));
    } catch (reason) {
      setCreationError(reason instanceof Error ? reason.message : "暂时无法打开私信。");
    } finally {
      setOpeningDirectMessage(null);
    }
  }

  async function inviteAgent(agentId: string) {
    const channelId = inviteChannels[agentId];
    if (!channelId) return;
    setInvitingAgent(agentId);
    setInvitationError(null);
    setInvitationNotice(null);
    try {
      const response = await fetch(
        `/api/owner/channels/${encodeURIComponent(channelId)}/invitations`,
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ agentId }),
        },
      );
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(result, "暂时无法邀请 Agent 加入频道。"));
      setInvitationNotice(
        `${agents.find((agent) => agent.id === agentId)?.name ?? "Agent"} 已加入频道。`,
      );
    } catch (reason) {
      setInvitationError(
        reason instanceof Error ? reason.message : "暂时无法邀请 Agent 加入频道。",
      );
    } finally {
      setInvitingAgent(null);
    }
  }

  const savedDraft = agents.find((agent) => agent.id === draft.id),
    selectedNode = nodes.find((node) => node.id === draft.nodeId),
    selectedProvider = providers.find((provider) => provider.id === draft.provider),
    onlineNodes = nodes.filter((node) => node.online),
    formLocked = savedDraft !== undefined,
    canSubmit =
      Boolean(selectedNode?.online) &&
      Boolean(selectedProvider?.models.some((model) => model.id === draft.modelId)) &&
      !submitting &&
      savedDraft?.status !== "waiting_credentials";

  return (
    <main className="page-shell agents-page-shell">
      <section className="agents-card" aria-labelledby="agents-title">
        <p className="eyebrow">MATE 控制面</p>
        <div className="agents-heading">
          <div>
            <h1 id="agents-title">Agent 同事</h1>
            <p className="agents-intro">
              为每个 Agent 选择节点与模型；节点在运行账号下创建它的默认工作区和记忆入口。
            </p>
          </div>
          <a className="subtle-link" href="/app">
            返回对话
          </a>
        </div>

        <section className="agent-form-section" aria-labelledby="model-credentials-title">
          <div className="agents-section-heading">
            <h2 id="model-credentials-title">模型服务凭据</h2>
          </div>
          <p className="agents-intro">
            每家服务保存一份 API key。页面只显示已配置状态；运行开始时控制面才会把 key 发送给节点。
          </p>
          <form className="agent-form" onSubmit={(event) => void submitCredential(event, refresh)}>
            <label>
              模型服务
              <select
                required
                value={credentialProvider}
                disabled={credentialBusy || providers.length === 0}
                onChange={(event) => setCredentialProvider(event.target.value)}
              >
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              API key
              <input
                type="password"
                autoComplete="new-password"
                required
                value={credentialKey}
                disabled={credentialBusy || providers.length === 0}
                onChange={(event) => setCredentialKey(event.target.value)}
              />
            </label>
            {credentialError && (
              <p className="form-error" role="alert">
                {credentialError}
              </p>
            )}
            {credentialSaved && (
              <p className="agent-field-hint" role="status">
                凭据已保存；服务列表不会显示 key。
              </p>
            )}
            <ul className="model-credential-list" aria-label="已配置模型服务">
              {credentials.map((credential) => (
                <li key={credential.provider}>
                  {providers.find((provider) => provider.id === credential.provider)?.name ??
                    credential.provider}
                  <span>已配置</span>
                  <button
                    type="button"
                    disabled={credentialBusy}
                    onClick={() => void revokeCredential(credential.provider, refresh)}
                  >
                    撤销 API key
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="submit"
              disabled={credentialBusy || !credentialProvider || !credentialKey}
            >
              {credentialBusy ? "正在保存…" : "保存或替换 API key"}
            </button>
          </form>
        </section>

        <section className="agent-form-section" aria-labelledby="create-agent-title">
          <div className="agents-section-heading">
            <h2 id="create-agent-title">创建 Agent</h2>
            <button
              className="agent-new-button"
              type="button"
              onClick={() => {
                const provider = providers[0];
                setDraft({
                  ...newDraft(),
                  provider: provider?.id ?? "",
                  modelId: provider?.models[0]?.id ?? "",
                });
                setCreationError(null);
              }}
              disabled={submitting}
            >
              新建资料
            </button>
          </div>
          <p className="agents-intro">
            只在选择在线节点后提交。尚未配置模型 key 时，Agent 会等待凭据；私信会先排队。
          </p>
          <form className="agent-form" onSubmit={submitForm}>
            <label>
              Linux 节点
              <select
                required
                value={draft.nodeId}
                disabled={formLocked || submitting}
                onChange={(event) => setDraft({ ...draft, nodeId: event.target.value })}
              >
                <option value="">选择在线节点</option>
                {nodes.map((node) => (
                  <option key={node.id} value={node.id} disabled={!node.online}>
                    {node.online ? "在线" : "离线"} · {node.id}
                  </option>
                ))}
              </select>
              {!loading && onlineNodes.length === 0 && (
                <span className="agent-field-hint">当前没有在线节点；资料不会提交。</span>
              )}
            </label>
            <label>
              名称
              <input
                required
                maxLength={80}
                value={draft.name}
                disabled={formLocked || submitting}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </label>
            <label>
              角色
              <input
                required
                maxLength={160}
                value={draft.role}
                disabled={formLocked || submitting}
                onChange={(event) => setDraft({ ...draft, role: event.target.value })}
              />
            </label>
            <label>
              介绍
              <textarea
                maxLength={1000}
                rows={3}
                value={draft.description}
                disabled={formLocked || submitting}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
            <div className="agent-model-fields">
              <label>
                模型提供方
                <select
                  required
                  value={draft.provider}
                  disabled={formLocked || submitting || providers.length === 0}
                  onChange={(event) => {
                    const provider = providers.find((item) => item.id === event.target.value);
                    setDraft({
                      ...draft,
                      provider: event.target.value,
                      modelId: provider?.models[0]?.id ?? "",
                    });
                  }}
                >
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                模型
                <select
                  required
                  value={draft.modelId}
                  disabled={formLocked || submitting || !selectedProvider}
                  onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
                >
                  {selectedProvider?.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              初始频道（可选）
              <select
                value={draft.initialChannelId}
                disabled={formLocked || submitting}
                onChange={(event) => setDraft({ ...draft, initialChannelId: event.target.value })}
              >
                <option value="">暂不邀请</option>
                {channels
                  .filter((channel) => !channel.archived)
                  .map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.name}
                    </option>
                  ))}
              </select>
            </label>
            {formLocked && (
              <p className="agent-field-hint">
                此请求已有稳定 Agent ID；继续操作会复用同一工作区、记忆入口与逻辑会话。
              </p>
            )}
            {refreshError && (
              <p className="form-error" role="alert">
                {refreshError}
              </p>
            )}
            {creationError && (
              <p className="form-error" role="alert">
                {creationError}
              </p>
            )}
            <button type="submit" disabled={!canSubmit}>
              {submitting
                ? "正在等待节点…"
                : savedDraft?.status === "failed" || savedDraft?.status === "provisioning"
                  ? "按同一请求继续"
                  : "创建 Agent"}
            </button>
          </form>
        </section>

        <section aria-labelledby="agent-list-title">
          <div className="agents-section-heading agent-list-heading">
            <h2 id="agent-list-title">已创建 Agent</h2>
            <span className="agent-refresh-note">每 3 秒更新</span>
          </div>
          {loading ? (
            <p className="agents-empty" role="status">
              正在读取 Agent 状态…
            </p>
          ) : agents.length === 0 ? (
            <p className="agents-empty">
              还没有 Agent。提交资料后，在线节点会在运行账号下创建它的默认工作区和记忆入口。
            </p>
          ) : (
            <ul className="agent-list">
              {agents.map((agent) => (
                <li className="agent-row" key={agent.id}>
                  <div className="agent-row-heading">
                    <div>
                      <h3>{agent.name}</h3>
                      <p>{agent.role}</p>
                    </div>
                    <span className={`agent-status agent-status-${agent.status}`}>
                      {agent.pausedReason === "manual"
                        ? "已停用"
                        : agent.pausedReason === "credentials"
                          ? "凭据或模型错误"
                          : agent.pausedReason === "context"
                            ? "上下文压缩待处理"
                            : agent.status === "waiting_credentials"
                              ? "等待凭据"
                              : agent.status === "provisioning"
                                ? "正在创建"
                                : agent.status === "ready"
                                  ? "已就绪"
                                  : "创建失败"}
                    </span>
                  </div>
                  {agent.pausedReason === "manual" && (
                    <p className="agent-credential-note" role="status">
                      {agentStopStatus(agent.stop).summary}
                      {agent.stop?.state === "succeeded"
                        ? "复启前会核对运行账号与 Agent 工作区。"
                        : ""}
                    </p>
                  )}
                  <p className="agent-stage" role="status">
                    {stageLabels[agent.stage]}
                  </p>
                  {agent.status === "waiting_credentials" && (
                    <p className="agent-credential-note">
                      默认工作区、记忆入口与会话已验证，运行账号为节点账号。配置模型凭据前不会启动运行；邀请频道中的消息会排队。
                    </p>
                  )}
                  {agent.status === "ready" && (
                    <p className="agent-credential-note">
                      模型服务凭据已配置；该 Agent 可以开始处理排队消息。
                    </p>
                  )}
                  {agent.error && <p className="form-error">{agent.error}</p>}
                  <p>
                    <a href={`/app/agents/${encodeURIComponent(agent.id)}/reminders`}>查看提醒</a>
                  </p>
                  {agent.linuxIdentity && (
                    <AgentEditor
                      agent={agent}
                      providers={providers}
                      credentials={credentials}
                      refresh={() => refresh()}
                    />
                  )}
                  {agent.linuxIdentity && (
                    <div className="agent-direct-message">
                      {directChannels[agent.id] ? (
                        <a href={`/app?channel=${encodeURIComponent(directChannels[agent.id]!)}`}>
                          打开私信
                        </a>
                      ) : (
                        <button
                          type="button"
                          disabled={openingDirectMessage !== null}
                          onClick={() => void openDirectMessage(agent.id)}
                        >
                          {openingDirectMessage === agent.id ? "正在打开…" : "私信"}
                        </button>
                      )}
                    </div>
                  )}
                  {agent.linuxIdentity && (
                    <div className="agent-direct-message">
                      <label>
                        邀请加入频道
                        <select
                          aria-label={`${agent.name} 邀请频道`}
                          value={inviteChannels[agent.id] ?? ""}
                          disabled={invitingAgent !== null || invitableChannels.length === 0}
                          onChange={(event) =>
                            setInviteChannels((current) => ({
                              ...current,
                              [agent.id]: event.target.value,
                            }))
                          }
                        >
                          <option value="">选择频道</option>
                          {invitableChannels.map((channel) => (
                            <option key={channel.id} value={channel.id}>
                              {channel.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={invitingAgent !== null || !inviteChannels[agent.id]}
                        onClick={() => void inviteAgent(agent.id)}
                      >
                        {invitingAgent === agent.id ? "正在邀请…" : "邀请加入"}
                      </button>
                      {invitationError && (
                        <p className="form-error" role="alert">
                          {invitationError}
                        </p>
                      )}
                      {invitationNotice && (
                        <p className="agent-field-hint" role="status">
                          {invitationNotice}
                        </p>
                      )}
                    </div>
                  )}
                  {agent.linuxIdentity && (
                    <dl className="agent-linux-identity">
                      <div>
                        <dt>运行账号</dt>
                        <dd>
                          <code>{agent.linuxIdentity.username}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>账号 UID / GID</dt>
                        <dd>
                          <code>
                            {agent.linuxIdentity.uid} / {agent.linuxIdentity.gid}
                          </code>
                        </dd>
                      </div>
                      <div>
                        <dt>默认工作区</dt>
                        <dd>
                          <code>{agent.linuxIdentity.workspace}</code>
                        </dd>
                      </div>
                    </dl>
                  )}
                  {agent.linuxIdentity && <AgentActivity agentId={agent.id} />}
                  {(agent.status === "failed" || agent.status === "provisioning") && (
                    <button
                      className="agent-retry-button"
                      type="button"
                      disabled={
                        submitting || !nodes.some((node) => node.id === agent.nodeId && node.online)
                      }
                      onClick={() => {
                        setDraft(draftFromAgent(agent));
                        void submitRequest(requestFromDraft(draftFromAgent(agent)));
                      }}
                    >
                      {agent.status === "failed" ? "按同一请求重试" : "继续此请求"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <WorkspaceBrowser agents={agents} nodes={nodes} />
      </section>
    </main>
  );
}
