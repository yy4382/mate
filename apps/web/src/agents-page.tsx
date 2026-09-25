import { useCallback, useEffect, useState, type FormEvent } from "react";
import { redirectToLogin } from "./navigation.js";
import "./agents-page.css";

interface NodeSummary {
  id: string;
  online: boolean;
  lastConnectedAt: string | null;
}

interface ChannelSummary {
  id: string;
  name: string;
  archived: boolean;
}

interface AgentSummary {
  id: string;
  nodeId: string;
  name: string;
  role: string;
  description: string;
  model: { provider: string; id: string };
  initialChannelId: string | null;
  sessionId: string;
  status: "provisioning" | "waiting_credentials" | "failed";
  stage:
    | "queued"
    | "checking_account"
    | "creating_account"
    | "preparing_home"
    | "verifying_identity"
    | "complete"
    | "failed";
  error: string | null;
  linuxIdentity: { username: string; uid: number; gid: number; home: string } | null;
  createdAt: number;
  updatedAt: number;
}

interface AgentRequest {
  id: string;
  nodeId: string;
  name: string;
  role: string;
  description: string;
  model: { provider: string; id: string };
  initialChannelId?: string;
}

interface Draft {
  id: string;
  nodeId: string;
  name: string;
  role: string;
  description: string;
  provider: string;
  modelId: string;
  initialChannelId: string;
}

const stageLabels: Record<AgentSummary["stage"], string> = {
  queued: "等待节点处理",
  checking_account: "检查 Linux 账号",
  creating_account: "创建 Linux 账号",
  preparing_home: "准备私人 home",
  verifying_identity: "核验账号与权限",
  complete: "账号和 home 已核验",
  failed: "创建未完成",
};

function newDraft(): Draft {
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

function requestFromDraft(draft: Draft): AgentRequest {
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

function draftFromAgent(agent: AgentSummary): Draft {
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

async function readJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (response.status === 401) {
    redirectToLogin();
    throw new Error("登录状态已失效");
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorMessage(result, "暂时无法读取控制面资料。"));
  return result as T;
}

function errorMessage(result: unknown, fallback: string): string {
  return typeof result === "object" && result !== null && "error" in result
    ? String(result.error)
    : fallback;
}

export function AgentsPage() {
  const [nodes, setNodes] = useState<NodeSummary[]>([]);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [creationError, setCreationError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const [nodeResult, channelResult, agentResult] = await Promise.all([
        readJSON<{ nodes: NodeSummary[] }>("/api/owner/nodes", signal),
        readJSON<{ channels: ChannelSummary[] }>("/api/owner/channels", signal),
        readJSON<{ agents: AgentSummary[] }>("/api/owner/agents", signal),
      ]);
      if (signal?.aborted) return;
      setNodes(nodeResult.nodes);
      setChannels(channelResult.channels);
      setAgents(agentResult.agents);
      setDraft((current) =>
        current.nodeId && nodeResult.nodes.some((node) => node.id === current.nodeId)
          ? current
          : { ...current, nodeId: nodeResult.nodes.find((node) => node.online)?.id ?? "" },
      );
      setRefreshError(null);
    } catch (reason) {
      if (!signal?.aborted)
        setRefreshError(reason instanceof Error ? reason.message : "读取失败，请重试。");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = window.setInterval(() => void refresh(controller.signal), 3000);
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
      if (typeof result === "object" && result !== null && "agent" in result) {
        const returnedAgent = (result as { agent: AgentSummary }).agent;
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

  const savedDraft = agents.find((agent) => agent.id === draft.id),
    selectedNode = nodes.find((node) => node.id === draft.nodeId),
    onlineNodes = nodes.filter((node) => node.online),
    formLocked = savedDraft !== undefined,
    canSubmit =
      Boolean(selectedNode?.online) && !submitting && savedDraft?.status !== "waiting_credentials";

  return (
    <main className="page-shell agents-page-shell">
      <section className="agents-card" aria-labelledby="agents-title">
        <p className="eyebrow">MATE 控制面</p>
        <div className="agents-heading">
          <div>
            <h1 id="agents-title">Agent 同事</h1>
            <p className="agents-intro">
              为每个 Agent 选择节点与模型；节点会创建独立的 Linux 账号和私人 home。
            </p>
          </div>
          <a className="subtle-link" href="/app">
            返回对话
          </a>
        </div>

        <section className="agent-form-section" aria-labelledby="create-agent-title">
          <div className="agents-section-heading">
            <h2 id="create-agent-title">创建 Agent</h2>
            <button
              className="agent-new-button"
              type="button"
              onClick={() => {
                setDraft(newDraft());
                setCreationError(null);
              }}
              disabled={submitting}
            >
              新建资料
            </button>
          </div>
          <p className="agents-intro">
            只在选择在线节点后提交。模型凭据尚未在此配置；创建完成后 Agent
            会等待凭据，频道消息可以排队。
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
                <input
                  required
                  maxLength={64}
                  pattern="[a-z][a-z0-9._-]*"
                  value={draft.provider}
                  disabled={formLocked || submitting}
                  onChange={(event) => setDraft({ ...draft, provider: event.target.value })}
                />
              </label>
              <label>
                模型 ID
                <input
                  required
                  maxLength={200}
                  value={draft.modelId}
                  disabled={formLocked || submitting}
                  onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
                />
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
                此请求已有稳定 Agent ID；继续操作会使用相同资料、Linux 身份与逻辑会话。
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
              还没有 Agent。提交资料后，在线节点会创建它的 Linux 身份和私人 home。
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
                      {agent.status === "waiting_credentials"
                        ? "等待凭据"
                        : agent.status === "provisioning"
                          ? "正在创建"
                          : "创建失败"}
                    </span>
                  </div>
                  <p className="agent-stage" role="status">
                    {stageLabels[agent.stage]}
                  </p>
                  {agent.status === "waiting_credentials" && (
                    <p className="agent-credential-note">
                      身份、home 与会话已验证。配置模型凭据前不会启动运行；邀请频道中的消息会排队。
                    </p>
                  )}
                  {agent.error && <p className="form-error">{agent.error}</p>}
                  {agent.linuxIdentity && (
                    <dl className="agent-linux-identity">
                      <div>
                        <dt>Linux 用户</dt>
                        <dd>
                          <code>{agent.linuxIdentity.username}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>UID / GID</dt>
                        <dd>
                          <code>
                            {agent.linuxIdentity.uid} / {agent.linuxIdentity.gid}
                          </code>
                        </dd>
                      </div>
                      <div>
                        <dt>私人 home</dt>
                        <dd>
                          <code>{agent.linuxIdentity.home}</code>
                        </dd>
                      </div>
                    </dl>
                  )}
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
      </section>
    </main>
  );
}
