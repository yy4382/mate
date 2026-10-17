import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { AgentView, CatalogModel } from "@mate/admin";
import { ApiError, del, post } from "../shell/api.ts";
import { Link } from "../shell/router.tsx";
import { ConfirmButton, ErrorLine } from "../shell/ui.tsx";
import { STATE_LABEL, adminKeys, totalTokens, useAgents, useModels, useNodes } from "./data.ts";

export type Settings = {
  model: { provider: string; modelId: string };
  thinkingLevel?: string;
  instructions?: string;
};

/** The model, thinking level and instructions of an Agent, as the form for creating one and the one for changing one. */
export function SettingsFields(props: {
  models: readonly CatalogModel[];
  value: { model: string; thinking: string; instructions: string };
  onChange: (value: { model: string; thinking: string; instructions: string }) => void;
}) {
  const { models, value } = props;
  const chosen = models.find((m) => `${m.provider}/${m.modelId}` === value.model);
  return (
    <>
      <label>
        模型
        <select
          value={value.model}
          onChange={(event) =>
            props.onChange({ ...value, model: event.target.value, thinking: "" })
          }
          required
        >
          <option value="">选择…</option>
          {models.map((m) => (
            <option key={`${m.provider}/${m.modelId}`} value={`${m.provider}/${m.modelId}`}>
              {m.provider} · {m.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        思考级别
        <select
          value={value.thinking}
          onChange={(event) => props.onChange({ ...value, thinking: event.target.value })}
        >
          <option value="">默认</option>
          {chosen?.thinkingLevels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
      <label>
        说明文字（可选）
        <textarea
          rows={3}
          value={value.instructions}
          onChange={(event) => props.onChange({ ...value, instructions: event.target.value })}
        />
      </label>
    </>
  );
}

export function settingsBody(value: {
  model: string;
  thinking: string;
  instructions: string;
}): Settings {
  const [provider = "", ...rest] = value.model.split("/");
  return {
    model: { provider, modelId: rest.join("/") },
    ...(value.thinking === "" ? {} : { thinkingLevel: value.thinking }),
    ...(value.instructions.trim() === "" ? {} : { instructions: value.instructions }),
  };
}

function CreateAgent({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const nodes = useNodes().data ?? [];
  const models = useModels().data ?? [];
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [settings, setSettings] = useState({ model: "", thinking: "", instructions: "" });
  const [error, setError] = useState<unknown>(null);
  const [unfinished, setUnfinished] = useState<string | null>(null);
  const node = nodes.length === 1 ? nodes[0]?.nodeId : nodeId;
  return (
    <form
      className="card form"
      aria-label="创建 Agent"
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          await post("/api/admin/agents", {
            ...(unfinished === null ? {} : { agentId: unfinished }),
            nodeId: node,
            displayName,
            handle,
            settings: settingsBody(settings),
          });
          await qc.invalidateQueries({ queryKey: ["admin"] });
          await qc.invalidateQueries({ queryKey: ["chat", "accounts"] });
          onDone();
        } catch (cause) {
          // A create that stopped part way is finished by sending its agentId back.
          if (cause instanceof ApiError && typeof cause.body.agentId === "string")
            setUnfinished(cause.body.agentId);
          setError(cause);
        }
      }}
    >
      <h3>创建 Agent</h3>
      <label>
        显示名
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          required
        />
      </label>
      <label>
        Handle
        <input
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          pattern="[\p{L}\p{N}][\p{L}\p{N}_.\-]*"
          required
        />
      </label>
      {nodes.length === 0 ? (
        <p className="notice">还没有配对的 node，先到「Node」里配对一个。</p>
      ) : nodes.length === 1 ? (
        <p>
          Node：<code>{nodes[0]?.nodeId}</code>
        </p>
      ) : (
        <label>
          Node
          <select value={nodeId} onChange={(event) => setNodeId(event.target.value)} required>
            <option value="">选择…</option>
            {nodes.map((n) => (
              <option key={n.nodeId} value={n.nodeId}>
                {n.nodeId}（{n.online ? "在线" : "离线"}）
              </option>
            ))}
          </select>
        </label>
      )}
      {models.length === 0 ? (
        <p className="notice">没有可选的模型，先到「提供商」里保存 API key。</p>
      ) : (
        <SettingsFields models={models} value={settings} onChange={setSettings} />
      )}
      <ErrorLine error={error} />
      <button
        className="button primary"
        type="submit"
        disabled={nodes.length === 0 || models.length === 0}
      >
        {unfinished === null ? "创建" : "继续创建"}
      </button>
    </form>
  );
}

function AgentCard({ agent }: { agent: AgentView }) {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      setError(null);
      await qc.invalidateQueries({ queryKey: adminKeys.agents });
    } catch (cause) {
      setError(cause);
    }
  };
  const readable = agent.state !== "unreadable";
  const name = agent.displayName ?? agent.agentId;
  return (
    <article className="card agent" data-agent={agent.handle ?? agent.agentId}>
      <header>
        <h3>{name}</h3>
        {agent.handle === undefined ? null : <span className="handle">@{agent.handle}</span>}
        <span className={agent.state === "open" ? "tag ok" : "tag"}>
          {STATE_LABEL[agent.state]}
        </span>
      </header>
      {readable ? (
        <p className="meta">
          {agent.settings.model.provider}/{agent.settings.model.modelId}
          {agent.settings.thinkingLevel === undefined
            ? ""
            : ` · 思考 ${agent.settings.thinkingLevel}`}
          {" · "}已用 {totalTokens(agent)} tokens
        </p>
      ) : (
        <p className="error">{agent.problem}</p>
      )}
      <div className="actions">
        {readable ? <Link to={`/app/admin/agents/${agent.agentId}`}>详情</Link> : null}
        {agent.handle === undefined || !readable ? null : (
          <Link to={`/app?dm=${encodeURIComponent(agent.handle)}`} className="button">
            发消息
          </Link>
        )}
        {agent.state === "open" ? (
          <button
            type="button"
            className="button"
            onClick={() => run(() => post(`/api/admin/agents/${agent.agentId}/pause`))}
          >
            暂停
          </button>
        ) : null}
        {agent.state === "paused" ? (
          <button
            type="button"
            className="button"
            onClick={() => run(() => post(`/api/admin/agents/${agent.agentId}/resume`))}
          >
            恢复
          </button>
        ) : null}
        <ConfirmButton
          label="删除"
          danger
          onConfirm={() => run(() => del(`/api/admin/agents/${agent.agentId}`))}
        />
      </div>
      <ErrorLine error={error} />
    </article>
  );
}

export function Agents() {
  const agents = useAgents();
  const [creating, setCreating] = useState(false);
  return (
    <section>
      <header className="section-header">
        <h2>Agent</h2>
        {creating ? null : (
          <button type="button" className="button primary" onClick={() => setCreating(true)}>
            创建 Agent
          </button>
        )}
      </header>
      {creating ? <CreateAgent onDone={() => setCreating(false)} /> : null}
      <ErrorLine error={agents.error} />
      {agents.data?.length === 0 && !creating ? <p className="empty">还没有 Agent。</p> : null}
      <div className="cards">
        {agents.data?.map((agent) => (
          <AgentCard key={agent.agentId} agent={agent} />
        ))}
      </div>
    </section>
  );
}
