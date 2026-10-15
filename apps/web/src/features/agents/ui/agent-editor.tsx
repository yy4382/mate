import {
  agentThinkingLevelSchema,
  type ModelCredentialSummary,
  type ModelProviderSummary,
} from "@mate/protocol/owner";
import { useLayoutEffect, useState } from "react";
import { jsonRequest, readResponseJSON, responseErrorMessage } from "../../../http-json.js";
import { redirectToLogin } from "../../../navigation.js";
import type { AgentSummary } from "../agent-responses.js";

export function AgentEditor({
  agent,
  providers,
  credentials,
  refresh,
}: {
  agent: AgentSummary;
  providers: ModelProviderSummary[];
  credentials: ModelCredentialSummary[];
  refresh: () => Promise<void>;
}) {
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [description, setDescription] = useState(agent.description);
  const [provider, setProvider] = useState(agent.model.provider);
  const [modelId, setModelId] = useState(agent.model.id);
  const [thinkingLevel, setThinkingLevel] = useState(agent.model.thinkingLevel ?? "default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Synchronize refreshed settings before the form can receive owner input.
  useLayoutEffect(() => {
    setName(agent.name);
    setRole(agent.role);
    setDescription(agent.description);
    setProvider(agent.model.provider);
    setModelId(agent.model.id);
    setThinkingLevel(agent.model.thinkingLevel ?? "default");
  }, [
    agent.name,
    agent.role,
    agent.description,
    agent.model.provider,
    agent.model.id,
    agent.model.thinkingLevel,
  ]);
  async function saveSettings({
    path,
    method,
    body,
  }: {
    path: string;
    method: "PATCH" | "PUT";
    body: object;
  }) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/owner/agents/${encodeURIComponent(agent.id)}/${path}`,
        jsonRequest(method, body),
      );
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const result = await readResponseJSON(response);
      if (!response.ok) throw new Error(responseErrorMessage(result, "无法保存 Agent 设置。"));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存 Agent 设置。");
    } finally {
      setBusy(false);
    }
  }
  const selectedProvider = providers.find((item) => item.id === provider);
  const hasModelCredential = credentials.some((item) => item.provider === provider);
  const thinkingLevels =
    selectedProvider?.models.find((item) => item.id === modelId)?.thinkingLevels ?? [];
  const supportedThinking =
    thinkingLevel === "default" || thinkingLevels.some((level) => level === thinkingLevel);
  const isCurrentModel =
    provider === agent.model.provider &&
    modelId === agent.model.id &&
    thinkingLevel === (agent.model.thinkingLevel ?? "default");

  return (
    <div className="agent-editor">
      <label>
        名称
        <input
          aria-label={`${agent.name} 名称`}
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={busy || !name.trim() || name.trim() === agent.name}
        onClick={() =>
          void saveSettings({ path: "profile", method: "PATCH", body: { name: name.trim() } })
        }
      >
        保存名称
      </button>
      <label>
        角色
        <input
          aria-label={`${agent.name} 角色`}
          maxLength={160}
          value={role}
          onChange={(event) => setRole(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={busy || !role.trim() || role.trim() === agent.role}
        onClick={() =>
          void saveSettings({ path: "profile", method: "PATCH", body: { role: role.trim() } })
        }
      >
        保存角色
      </button>
      <label>
        描述
        <textarea
          aria-label={`${agent.name} 描述`}
          maxLength={1000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={busy || description.trim() === agent.description}
        onClick={() =>
          void saveSettings({
            path: "profile",
            method: "PATCH",
            body: { description: description.trim() },
          })
        }
      >
        保存描述
      </button>
      <label>
        模型服务
        <select
          aria-label={`${agent.name} 模型服务`}
          value={provider}
          onChange={(event) => {
            const next = providers.find((item) => item.id === event.target.value);
            setProvider(event.target.value);
            setModelId(next?.models[0]?.id ?? "");
          }}
        >
          {providers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        模型
        <select
          aria-label={`${agent.name} 模型`}
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
        >
          {selectedProvider?.models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        思考强度
        <select
          aria-label={`${agent.name} 思考强度`}
          value={thinkingLevel}
          onChange={(event) => setThinkingLevel(agentThinkingLevelSchema.parse(event.target.value))}
        >
          <option value="default">默认</option>
          {!supportedThinking && (
            <option value={thinkingLevel} disabled>
              {thinkingLabel(thinkingLevel)}（当前模型不支持）
            </option>
          )}
          {thinkingLevels.map((level) => (
            <option key={level} value={level}>
              {thinkingLabel(level)}
            </option>
          ))}
        </select>
      </label>
      {!supportedThinking && (
        <p className="agent-field-hint">当前模型不支持已选思考强度，请选择默认或支持的级别。</p>
      )}
      <p className="agent-field-hint">
        主会话和工作助手共用此选择。默认沿用系统行为；不同模型的强度不等效。
      </p>
      {!hasModelCredential && <p className="agent-field-hint">请先配置目标模型服务的 API key。</p>}
      <button
        type="button"
        disabled={busy || !modelId || !hasModelCredential || !supportedThinking || isCurrentModel}
        onClick={() =>
          void saveSettings({
            path: "model",
            method: "PUT",
            body: {
              provider,
              id: modelId,
              ...(thinkingLevel === "default" ? {} : { thinkingLevel }),
            },
          })
        }
      >
        切换模型
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function thinkingLabel(level: "default" | "low" | "medium" | "high") {
  return { default: "默认", low: "低", medium: "中", high: "高" }[level];
}
