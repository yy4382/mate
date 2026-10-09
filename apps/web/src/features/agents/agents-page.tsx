import type { ModelProviderSummary } from "@mate/protocol/owner";
import { useCallback, useState, type FormEvent } from "react";
import { jsonRequest, readResponseJSON, responseErrorMessage } from "../../http-json.js";
import { redirectToLogin } from "../../navigation.js";
import type { NodeSummary } from "../nodes/node-responses.js";
import {
  draftFromAgent,
  newDraft,
  requestFromDraft,
  type AgentRequest,
  type Draft,
} from "./agent-draft.js";
import { agentResponseSchema, directChannelResponseSchema } from "./agent-responses.js";
import "./agents-page.css";
// Workspace form styles follow the shared Agent form styles in the cascade.
import { WorkspaceBrowser } from "../workspace/workspace-browser.js";
import { useAgentDirectory } from "./data/use-agent-directory.js";
import { useModelCredentials } from "./data/use-model-credentials.js";
import { AgentActivity } from "./ui/agent-activity.js";
import { AgentCreationForm } from "./ui/agent-creation-form.js";
import { AgentEditor } from "./ui/agent-editor.js";
import { agentStopStatus } from "./ui/agent-stop-status.js";
import { agentStageLabels, agentStatusLabel } from "./ui/agent-status.js";
import { ModelCredentialsForm } from "./ui/model-credentials-form.js";

export function AgentsPage() {
  const [directChannels, setDirectChannels] = useState<Record<string, string>>({});
  const [openingDirectMessage, setOpeningDirectMessage] = useState<string | null>(null);
  const [inviteChannels, setInviteChannels] = useState<Record<string, string>>({});
  const [invitingAgent, setInvitingAgent] = useState<string | null>(null);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [invitationNotice, setInvitationNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [submitting, setSubmitting] = useState(false);
  const [creationError, setCreationError] = useState<string | null>(null);
  const credentialControls = useModelCredentials();
  const { reconcileProviders } = credentialControls;
  const onRefreshed = useCallback(
    (nodes: NodeSummary[], providers: ModelProviderSummary[]) => {
      reconcileProviders(providers);
      setDraft((current) => {
        const provider =
          providers.find((candidate) => candidate.id === current.provider) ?? providers[0];
        const model =
          provider?.models.find((candidate) => candidate.id === current.modelId) ??
          provider?.models[0];
        return {
          ...current,
          nodeId:
            current.nodeId && nodes.some((node) => node.id === current.nodeId)
              ? current.nodeId
              : (nodes.find((node) => node.online)?.id ?? ""),
          provider: provider?.id ?? "",
          modelId: model?.id ?? "",
        };
      });
    },
    [reconcileProviders],
  );
  const directory = useAgentDirectory(onRefreshed);
  const {
    nodes,
    channels,
    invitableChannels,
    agents,
    providers,
    credentials,
    loading,
    refreshError,
    refresh,
  } = directory;

  async function submitAgentRequest(request: AgentRequest) {
    setSubmitting(true);
    setCreationError(null);
    try {
      const response = await fetch("/api/owner/agents", jsonRequest("POST", request));
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const result = await readResponseJSON(response);
      const returned = agentResponseSchema.safeParse(result);
      if (returned.success) {
        const returnedAgent = returned.data.agent;
        directory.recordReturnedAgent(returnedAgent);
      }
      if (!response.ok)
        throw new Error(responseErrorMessage(result, "Agent 创建失败，请按同一请求重试。"));
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

  function submitCreationForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitAgentRequest(requestFromDraft(draft));
  }

  function startNewDraft() {
    const provider = providers[0];
    setDraft({
      ...newDraft(),
      provider: provider?.id ?? "",
      modelId: provider?.models[0]?.id ?? "",
    });
    setCreationError(null);
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
      const result = await readResponseJSON(response);
      if (!response.ok) throw new Error(responseErrorMessage(result, "暂时无法打开私信。"));
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
        jsonRequest("POST", { agentId }),
      );
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const result = await readResponseJSON(response);
      if (!response.ok)
        throw new Error(responseErrorMessage(result, "暂时无法邀请 Agent 加入频道。"));
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

        <ModelCredentialsForm
          providers={providers}
          credentials={credentials}
          controls={credentialControls}
          refresh={refresh}
        />

        <AgentCreationForm
          draft={draft}
          savedDraft={agents.find((agent) => agent.id === draft.id)}
          nodes={nodes}
          channels={channels}
          providers={providers}
          loading={loading}
          submitting={submitting}
          refreshError={refreshError}
          creationError={creationError}
          onDraftChange={setDraft}
          onNewDraft={startNewDraft}
          onSubmit={submitCreationForm}
        />

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
              {agents.map((agent) => {
                const directChannelId = directChannels[agent.id];
                return (
                  <li className="agent-row" key={agent.id}>
                    <div className="agent-row-heading">
                      <div>
                        <h3>{agent.name}</h3>
                        <p>{agent.role}</p>
                      </div>
                      <span className={`agent-status agent-status-${agent.status}`}>
                        {agentStatusLabel(agent)}
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
                      {agentStageLabels[agent.stage]}
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
                      <>
                        <AgentEditor
                          agent={agent}
                          providers={providers}
                          credentials={credentials}
                          refresh={refresh}
                        />
                        <div className="agent-direct-message">
                          {directChannelId ? (
                            <a href={`/app?channel=${encodeURIComponent(directChannelId)}`}>
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
                        <AgentActivity agentId={agent.id} />
                      </>
                    )}
                    {(agent.status === "failed" || agent.status === "provisioning") && (
                      <button
                        className="agent-retry-button"
                        type="button"
                        disabled={
                          submitting ||
                          !nodes.some((node) => node.id === agent.nodeId && node.online)
                        }
                        onClick={() => {
                          const retryDraft = draftFromAgent(agent);
                          setDraft(retryDraft);
                          void submitAgentRequest(requestFromDraft(retryDraft));
                        }}
                      >
                        {agent.status === "failed" ? "按同一请求重试" : "继续此请求"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <WorkspaceBrowser agents={agents} nodes={nodes} />
      </section>
    </main>
  );
}
