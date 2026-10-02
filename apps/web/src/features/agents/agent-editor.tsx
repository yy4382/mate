import type { AgentSummary } from "./agent-responses.js";
import { useEffect, useState } from "react";
import type {
  ModelCredentialSummary as ModelCredential,
  ModelProviderSummary as ModelProvider,
} from "@mate/protocol/owner";
import { redirectToLogin } from "../../navigation.js";
import { errorMessage } from "./agent-requests.js";

export function AgentEditor({
  agent,
  providers,
  credentials,
  refresh,
}: {
  agent: AgentSummary;
  providers: ModelProvider[];
  credentials: ModelCredential[];
  refresh: () => Promise<void>;
}) {
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [description, setDescription] = useState(agent.description);
  const [provider, setProvider] = useState(agent.model.provider);
  const [modelId, setModelId] = useState(agent.model.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(agent.name);
    setRole(agent.role);
    setDescription(agent.description);
    setProvider(agent.model.provider);
    setModelId(agent.model.id);
  }, [agent.name, agent.role, agent.description, agent.model.provider, agent.model.id]);
  async function save(path: string, method: "PATCH" | "PUT", body: object) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/owner/agents/${encodeURIComponent(agent.id)}/${path}`, {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorMessage(result, "无法保存 Agent 设置。"));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存 Agent 设置。");
    } finally {
      setBusy(false);
    }
  }
  const selected = providers.find((item) => item.id === provider);
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
        onClick={() => void save("profile", "PATCH", { name: name.trim() })}
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
        onClick={() => void save("profile", "PATCH", { role: role.trim() })}
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
        onClick={() => void save("profile", "PATCH", { description: description.trim() })}
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
          {selected?.models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {!credentials.some((item) => item.provider === provider) && (
        <p className="agent-field-hint">请先配置目标模型服务的 API key。</p>
      )}
      <button
        type="button"
        disabled={
          busy ||
          !modelId ||
          !credentials.some((item) => item.provider === provider) ||
          (provider === agent.model.provider && modelId === agent.model.id)
        }
        onClick={() => void save("model", "PUT", { provider, id: modelId })}
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
