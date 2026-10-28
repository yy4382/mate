import { Trans } from "react-i18next";
import { t } from "../i18n.ts";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, MessageSquare, Plus } from "lucide-react";
import { useState } from "react";
import type { AgentView, CatalogModel } from "@mate/admin";
import { ApiError, post } from "../shell/api.ts";
import { HANDLE_PATTERN } from "../shell/humans.ts";
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
import { thinkingLabel, STATE_LABEL, totalTokens, useAgents, useModels, useNodes } from "./data.ts";

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
      <Field label={t("Agents.model")}>
        <Select
          value={value.model}
          onChange={(event) =>
            props.onChange({ ...value, model: event.target.value, thinking: "" })
          }
          required
        >
          <option value="">{t("Agents.select")}</option>
          {models.map((m) => (
            <option key={`${m.provider}/${m.modelId}`} value={`${m.provider}/${m.modelId}`}>
              {m.provider} · {m.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("Agents.thinkingLevel")}>
        <Select
          value={value.thinking}
          onChange={(event) => props.onChange({ ...value, thinking: event.target.value })}
        >
          <option value="">{t("Agents.default")}</option>
          {chosen?.thinkingLevels.map((level) => (
            <option key={level} value={level}>
              {thinkingLabel(level)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("Agents.instructionsOptional")}>
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
      title={t("Agents.createAgent")}
      description={t("Agents.giveItANameAndChooseAModel")}
      onClose={props.onClose}
    >
      <form
        className="grid gap-4"
        aria-label={t("Agents.createAgent")}
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
        <Field label={t("Agents.displayName")}>
          <Input
            value={displayName}
            onChange={(event) => onDraft((d) => ({ ...d, displayName: event.target.value }))}
            required
          />
        </Field>
        <Field label={t("common.handle")}>
          <Input
            value={handle}
            onChange={(event) => onDraft((d) => ({ ...d, handle: event.target.value }))}
            pattern={HANDLE_PATTERN}
            required
          />
        </Field>
        {nodes.length === 0 ? (
          <Notice>
            <Trans
              i18nKey="Agents.pairFirst"
              components={{
                nodes: (
                  <Link to="/app/admin/nodes" className={linkClass}>
                    {null}
                  </Link>
                ),
              }}
            />
          </Notice>
        ) : nodes.length === 1 ? (
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">{t("common.node")}</span>
            <span className="text-sm text-muted">{nodes[0]?.name}</span>
          </div>
        ) : (
          <Field label={t("common.node")}>
            <Select
              value={nodeId}
              onChange={(event) => onDraft((d) => ({ ...d, nodeId: event.target.value }))}
              required
            >
              <option value="">{t("Agents.select")}</option>
              {nodes.map((n) => (
                <option key={n.nodeId} value={n.nodeId}>
                  {t("Agents.nodeOption", {
                    name: n.name,
                    status: n.online ? t("Agents.online") : t("Agents.offline"),
                  })}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {models.length === 0 ? (
          <Notice>
            <Trans
              i18nKey="Agents.keyFirst"
              components={{
                providers: (
                  <Link to="/app/admin/providers" className={linkClass}>
                    {null}
                  </Link>
                ),
              }}
            />
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
            {unfinished === null ? t("Agents.create") : t("Agents.continueCreating")}
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
        <Avatar
          name={name}
          size="md"
          {...(agent.accountId === undefined ? {} : { agentAccount: agent.accountId })}
        />
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
                : t("Agents.thinkingSummary", {
                    level: thinkingLabel(agent.settings.thinkingLevel),
                  })}
              {" · "}
              {t("Agents.tokensUsed", { count: totalTokens(agent) })}
              {t("Agents.homeNodeSummary", { name: agent.nodeName })}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {agent.handle === undefined || agent.state === "unreadable" ? null : (
            <Link
              to={`/app?dm=${encodeURIComponent(agent.handle)}`}
              className={buttonClass({ size: "sm", className: "max-sm:size-8 max-sm:px-0" })}
              aria-label={t("Agents.sendMessage")}
            >
              <MessageSquare aria-hidden />
              <span className="max-sm:hidden">{t("Agents.sendMessage")}</span>
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
      {t("Agents.createAgent")}
    </Button>
  );
  const empty = agents.data?.length === 0;
  return (
    <>
      <PageHeader
        title={t("common.agents")}
        description={t("Agents.persistentAiColleaguesEachAgentHasItsOwn")}
        actions={empty ? undefined : create}
      />
      <ErrorLine error={agents.error} />
      {empty ? (
        <EmptyState icon={<Bot />} title={t("Agents.noAgentsYet")} action={create}>
          {t("Agents.createAnAgentToStartWorkingWithIt")}
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
