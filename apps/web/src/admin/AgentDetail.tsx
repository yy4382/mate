import { useQueryClient } from "@tanstack/react-query";
import { Check, MessageSquare } from "lucide-react";
import { useState } from "react";
import { put } from "../shell/api.ts";
import { Link, navigate } from "../shell/router.tsx";
import {
  Avatar,
  Button,
  Card,
  CardBody,
  CardFooter,
  EmptyState,
  ErrorLine,
  PageHeader,
  TabPanel,
  Tabs,
  buttonClass,
  cx,
  feedbackClass,
} from "../shell/ui.tsx";
import { AgentActions } from "./AgentActions.tsx";
import { AgentStateBadge, SettingsFields, settingsBody } from "./Agents.tsx";
import { NodeAccess } from "./NodeAccess.tsx";
import { Watch } from "./Watch.tsx";
import { Workspace } from "./Workspace.tsx";
import { adminKeys, useAgents, useModels } from "./data.ts";

type Tab = "settings" | "watch" | "workspace";

const TABS: { value: Tab; label: string }[] = [
  { value: "settings", label: "设置" },
  { value: "watch", label: "观察" },
  { value: "workspace", label: "工作区" },
];

function Breadcrumb({ name }: { name: string }) {
  return (
    <nav aria-label="面包屑" className="flex items-center gap-2 text-sm text-muted">
      <Link to="/app/admin/agents" className="text-muted no-underline hover:text-foreground">
        Agent
      </Link>
      <span aria-hidden>/</span>
      <span className="truncate text-foreground">{name}</span>
    </nav>
  );
}

export function AgentDetail({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const agents = useAgents();
  const agent = agents.data?.find((a) => a.agentId === agentId);
  const models = useModels().data ?? [];
  const [tab, setTab] = useState<Tab>("settings");
  const [form, setForm] = useState<{
    model: string;
    thinking: string;
    instructions: string;
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  if (agent === undefined)
    return agents.data === undefined ? null : (
      <>
        <Breadcrumb name="未知" />
        <EmptyState title="找不到这个 Agent。">它可能已经被删除了。</EmptyState>
      </>
    );
  if (agent.state === "unreadable")
    return (
      <>
        <Breadcrumb name={agent.displayName ?? agent.agentId} />
        <ErrorLine error={agent.problem} />
      </>
    );
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
  const name = agent.displayName ?? agent.agentId;
  return (
    <>
      <div className="grid gap-4">
        <Breadcrumb name={name} />
        <PageHeader
          title={name}
          leading={
            <Avatar
              name={name}
              size="lg"
              {...(agent.accountId === undefined ? {} : { agentAccount: agent.accountId })}
            />
          }
          badge={
            <>
              {agent.handle === undefined ? null : (
                <span className="text-sm text-muted">@{agent.handle}</span>
              )}
              <AgentStateBadge state={agent.state} />
            </>
          }
          actions={
            <>
              {agent.handle === undefined ? null : (
                <Link to={`/app?dm=${encodeURIComponent(agent.handle)}`} className={buttonClass()}>
                  <MessageSquare aria-hidden />
                  发消息
                </Link>
              )}
              <AgentActions
                agent={agent}
                onError={setActionError}
                onDeleted={() => navigate("/app/admin/agents")}
              />
            </>
          }
        />
        <ErrorLine error={actionError} />
      </div>
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} items={TABS}>
        <TabPanel value="settings">
          <form
            className="mb-6"
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
            <Card>
              <CardBody>
                <SettingsFields
                  models={choices}
                  value={value}
                  onChange={(next) => {
                    setSaved(false);
                    setForm(next);
                  }}
                />
                <ErrorLine error={error} />
              </CardBody>
              <CardFooter>
                {saved ? (
                  <p
                    role="status"
                    className={cx("flex items-center gap-1.5 text-sm text-success", feedbackClass)}
                  >
                    <Check aria-hidden className="size-4" />
                    已保存，从下一次请求起生效。
                  </p>
                ) : (
                  <p className="text-xs text-muted">从下一次模型请求起生效</p>
                )}
                <Button type="submit" variant="primary">
                  保存设置
                </Button>
              </CardFooter>
            </Card>
          </form>
          <NodeAccess agent={agent} />
        </TabPanel>
        <TabPanel value="watch">
          <Watch agentId={agentId} open={agent.state === "open"} />
        </TabPanel>
        <TabPanel value="workspace">
          <Workspace agentId={agentId} />
        </TabPanel>
      </Tabs>
    </>
  );
}
