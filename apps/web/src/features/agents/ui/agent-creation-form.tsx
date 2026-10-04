import type { ModelProviderSummary as ModelProvider } from "@mate/protocol/owner";
import type { FormEvent } from "react";
import type { NodeSummary } from "../../nodes/node-responses.js";
import type { Draft } from "../agent-draft.js";
import type { AgentSummary, ChannelSummary } from "../agent-responses.js";

export function AgentCreationForm({
  draft,
  savedDraft,
  nodes,
  channels,
  providers,
  loading,
  submitting,
  refreshError,
  creationError,
  onDraftChange,
  onNewDraft,
  submitForm,
}: {
  draft: Draft;
  savedDraft: AgentSummary | undefined;
  nodes: NodeSummary[];
  channels: ChannelSummary[];
  providers: ModelProvider[];
  loading: boolean;
  submitting: boolean;
  refreshError: string | null;
  creationError: string | null;
  onDraftChange: (draft: Draft) => void;
  onNewDraft: () => void;
  submitForm: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const selectedNode = nodes.find((node) => node.id === draft.nodeId),
    selectedProvider = providers.find((provider) => provider.id === draft.provider),
    onlineNodes = nodes.filter((node) => node.online),
    formLocked = savedDraft !== undefined,
    canSubmit =
      Boolean(selectedNode?.online) &&
      Boolean(selectedProvider?.models.some((model) => model.id === draft.modelId)) &&
      !submitting &&
      savedDraft?.status !== "waiting_credentials";
  return (
    <section className="agent-form-section" aria-labelledby="create-agent-title">
      <div className="agents-section-heading">
        <h2 id="create-agent-title">创建 Agent</h2>
        <button
          className="agent-new-button"
          type="button"
          onClick={() => {
            onNewDraft();
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
            onChange={(event) => onDraftChange({ ...draft, nodeId: event.target.value })}
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
            onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
          />
        </label>
        <label>
          角色
          <input
            required
            maxLength={160}
            value={draft.role}
            disabled={formLocked || submitting}
            onChange={(event) => onDraftChange({ ...draft, role: event.target.value })}
          />
        </label>
        <label>
          介绍
          <textarea
            maxLength={1000}
            rows={3}
            value={draft.description}
            disabled={formLocked || submitting}
            onChange={(event) => onDraftChange({ ...draft, description: event.target.value })}
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
                onDraftChange({
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
              onChange={(event) => onDraftChange({ ...draft, modelId: event.target.value })}
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
            onChange={(event) => onDraftChange({ ...draft, initialChannelId: event.target.value })}
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
  );
}
