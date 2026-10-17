import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { put } from "../shell/api.ts";
import { Link } from "../shell/router.tsx";
import { ErrorLine } from "../shell/ui.tsx";
import { SettingsFields, settingsBody } from "./Agents.tsx";
import { Watch } from "./Watch.tsx";
import { Workspace } from "./Workspace.tsx";
import { STATE_LABEL, adminKeys, useAgents, useModels } from "./data.ts";

type Tab = "settings" | "watch" | "workspace";

export function AgentDetail({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const agent = useAgents().data?.find((a) => a.agentId === agentId);
  const models = useModels().data ?? [];
  const [tab, setTab] = useState<Tab>("settings");
  const [form, setForm] = useState<{
    model: string;
    thinking: string;
    instructions: string;
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (agent === undefined) return <p className="empty">找不到这个 Agent。</p>;
  if (agent.state === "unreadable") return <p className="error">{agent.problem}</p>;
  const current = {
    model: `${agent.settings.model.provider}/${agent.settings.model.modelId}`,
    thinking: agent.settings.thinkingLevel ?? "",
    instructions: agent.settings.instructions ?? "",
  };
  const value = form ?? current;
  const known = models.some((m) => `${m.provider}/${m.modelId}` === current.model);
  const choices = known
    ? models
    : [
        ...models,
        {
          provider: agent.settings.model.provider,
          modelId: agent.settings.model.modelId,
          name: agent.settings.model.modelId,
          thinkingLevels: [],
          contextWindow: 0,
        },
      ];
  return (
    <section>
      <header className="section-header">
        <h2>
          {agent.displayName} <span className="handle">@{agent.handle}</span>
        </h2>
        <span className={agent.state === "open" ? "tag ok" : "tag"}>
          {STATE_LABEL[agent.state]}
        </span>
        <Link to="/app/admin/agents">返回</Link>
      </header>
      <div className="segmented" role="tablist">
        {(
          [
            ["settings", "设置"],
            ["watch", "观察"],
            ["workspace", "工作区"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "settings" ? (
        <form
          className="card form"
          aria-label="Agent 设置"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await put(`/api/admin/agents/${agentId}/settings`, settingsBody(value));
              setError(null);
              setSaved(true);
              setForm(null);
              await qc.invalidateQueries({ queryKey: adminKeys.agents });
            } catch (cause) {
              setSaved(false);
              setError(cause);
            }
          }}
        >
          <SettingsFields
            models={choices}
            value={value}
            onChange={(next) => {
              setSaved(false);
              setForm(next);
            }}
          />
          <ErrorLine error={error} />
          {saved ? (
            <p className="notice" role="status">
              已保存，从下一次请求起生效。
            </p>
          ) : null}
          <button className="button primary" type="submit">
            保存设置
          </button>
        </form>
      ) : null}
      {tab === "watch" ? <Watch agentId={agentId} open={agent.state === "open"} /> : null}
      {tab === "workspace" ? <Workspace agentId={agentId} /> : null}
    </section>
  );
}
