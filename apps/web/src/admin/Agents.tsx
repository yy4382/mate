import { useQueryClient } from "@tanstack/react-query";
import { Bot, MessageSquare, Plus } from "lucide-react";
import { useState } from "react";
import type { AgentView, CatalogModel } from "@mate/admin";
import { ApiError, post } from "../shell/api.ts";
import { Link } from "../shell/router.tsx";
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorLine,
  Field,
  Input,
  Notice,
  PageHeader,
  Select,
  Textarea,
  buttonClass,
  type Tone,
} from "../shell/ui.tsx";
import { AgentActions } from "./AgentActions.tsx";
import { STATE_LABEL, totalTokens, useAgents, useModels, useNodes } from "./data.ts";

const STATE_TONE: Record<string, Tone> = {
  open: "success",
  paused: "warning",
  closed: "neutral",
  unreadable: "danger",
};

export function AgentStateBadge({ state }: { state: AgentView["state"] }) {
  return <Badge tone={STATE_TONE[state] ?? "neutral"}>{STATE_LABEL[state]}</Badge>;
}

const linkClass = "text-accent no-underline hover:underline";

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
      <Field label="模型">
        <Select
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
        </Select>
      </Field>
      <Field label="思考级别">
        <Select
          value={value.thinking}
          onChange={(event) => props.onChange({ ...value, thinking: event.target.value })}
        >
          <option value="">默认</option>
          {chosen?.thinkingLevels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="说明文字（可选）">
        <Textarea
          rows={3}
          value={value.instructions}
          onChange={(event) => props.onChange({ ...value, instructions: event.target.value })}
        />
      </Field>
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

/** What the create form holds. It lives in `Agents`, so closing the dialog keeps it; only a successful create clears it. */
type Draft = {
  displayName: string;
  handle: string;
  nodeId: string;
  settings: { model: string; thinking: string; instructions: string };
  /** The agentId of a create that stopped part way; sending it back finishes that create. */
  unfinished: string | null;
};

const emptyDraft: Draft = {
  displayName: "",
  handle: "",
  nodeId: "",
  settings: { model: "", thinking: "", instructions: "" },
  unfinished: null,
};

function CreateAgent(props: {
  draft: Draft;
  onDraft: (update: (draft: Draft) => Draft) => void;
  onDone: () => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const nodes = useNodes().data ?? [];
  const models = useModels().data ?? [];
  const [error, setError] = useState<unknown>(null);
  const { draft, onDraft } = props;
  const { displayName, handle, nodeId, settings, unfinished } = draft;
  const node = nodes.length === 1 ? nodes[0]?.nodeId : nodeId;
  return (
    <Dialog
      title="创建 Agent"
      description="给它起个名字，选好模型，它就会在聊天里上线。"
      onClose={props.onClose}
    >
      <form
        className="grid gap-4"
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
            props.onDone();
          } catch (cause) {
            // A create that stopped part way is finished by sending its agentId back.
            if (cause instanceof ApiError && typeof cause.body.agentId === "string")
              onDraft((d) => ({ ...d, unfinished: cause.body.agentId as string }));
            setError(cause);
          }
        }}
      >
        <Field label="显示名">
          <Input
            value={displayName}
            onChange={(event) => onDraft((d) => ({ ...d, displayName: event.target.value }))}
            required
          />
        </Field>
        <Field label="Handle">
          <Input
            value={handle}
            onChange={(event) => onDraft((d) => ({ ...d, handle: event.target.value }))}
            pattern="[\p{L}\p{N}][\p{L}\p{N}_.\-]*"
            required
          />
        </Field>
        {nodes.length === 0 ? (
          <Notice>
            还没有配对的 node，先到
            <Link to="/app/admin/nodes" className={linkClass}>
              Node
            </Link>
            里配对一个。
          </Notice>
        ) : nodes.length === 1 ? (
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Node</span>
            <code className="font-mono text-xs text-muted">{nodes[0]?.nodeId}</code>
          </div>
        ) : (
          <Field label="Node">
            <Select
              value={nodeId}
              onChange={(event) => onDraft((d) => ({ ...d, nodeId: event.target.value }))}
              required
            >
              <option value="">选择…</option>
              {nodes.map((n) => (
                <option key={n.nodeId} value={n.nodeId}>
                  {n.nodeId}（{n.online ? "在线" : "离线"}）
                </option>
              ))}
            </Select>
          </Field>
        )}
        {models.length === 0 ? (
          <Notice>
            没有可选的模型，先到
            <Link to="/app/admin/providers" className={linkClass}>
              提供商
            </Link>
            里保存 API key。
          </Notice>
        ) : (
          <SettingsFields
            models={models}
            value={settings}
            onChange={(value) => onDraft((d) => ({ ...d, settings: value }))}
          />
        )}
        <ErrorLine error={error} />
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            disabled={nodes.length === 0 || models.length === 0}
          >
            {unfinished === null ? "创建" : "继续创建"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AgentRow({ agent }: { agent: AgentView }) {
  const [error, setError] = useState<unknown>(null);
  const name = agent.displayName ?? agent.agentId;
  return (
    <li className="grid gap-2 p-4" data-agent={agent.handle ?? agent.agentId}>
      <div className="flex items-center gap-3">
        <Avatar name={name} size="md" />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {agent.state === "unreadable" ? (
              <span className="truncate text-sm font-medium">{name}</span>
            ) : (
              <Link
                to={`/app/admin/agents/${agent.agentId}`}
                className="truncate text-sm font-medium text-foreground no-underline hover:underline"
              >
                {name}
              </Link>
            )}
            {agent.handle === undefined ? null : (
              <span className="text-sm text-muted">@{agent.handle}</span>
            )}
            <AgentStateBadge state={agent.state} />
          </div>
          {agent.state === "unreadable" ? (
            <p className="text-xs text-danger">{agent.problem}</p>
          ) : (
            <p className="break-words text-xs text-muted">
              {agent.settings.model.provider}/{agent.settings.model.modelId}
              {agent.settings.thinkingLevel === undefined
                ? ""
                : ` · 思考 ${agent.settings.thinkingLevel}`}
              {" · "}已用 {totalTokens(agent)} tokens
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {agent.handle === undefined || agent.state === "unreadable" ? null : (
            <Link
              to={`/app?dm=${encodeURIComponent(agent.handle)}`}
              className={buttonClass({ size: "sm", className: "max-sm:size-8 max-sm:px-0" })}
              aria-label="发消息"
            >
              <MessageSquare aria-hidden />
              <span className="max-sm:hidden">发消息</span>
            </Link>
          )}
          <AgentActions agent={agent} onError={setError} />
        </div>
      </div>
      <ErrorLine error={error} />
    </li>
  );
}

export function Agents() {
  const agents = useAgents();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const create = (
    <Button variant="primary" onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      创建 Agent
    </Button>
  );
  const empty = agents.data?.length === 0;
  return (
    <>
      <PageHeader
        title="Agent"
        description="常驻的 AI 同事。每个 Agent 有自己的上下文和工作目录。"
        actions={empty ? undefined : create}
      />
      <ErrorLine error={agents.error} />
      {empty ? (
        <EmptyState icon={<Bot />} title="还没有 Agent。" action={create}>
          创建一个，它就会出现在聊天里，等你交代事情。
        </EmptyState>
      ) : null}
      {agents.data === undefined || empty ? null : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {agents.data.map((agent) => (
            <AgentRow key={agent.agentId} agent={agent} />
          ))}
        </ul>
      )}
      {creating ? (
        <CreateAgent
          draft={draft}
          onDraft={(update) => setDraft(update)}
          onDone={() => {
            setDraft(emptyDraft);
            setCreating(false);
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  );
}
