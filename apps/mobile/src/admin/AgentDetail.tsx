import type { AgentView, CatalogModel } from "@mate/admin";
import { router } from "expo-router";
import { useState } from "react";
import { useSessionChat } from "../session";
import { stateLabel, type ReadableAgent } from "./Agents";
import { NodeAccess } from "./NodeAccess";
import { useClient, useOperation, useResource } from "./session";
import { SettingsFields, settingsBody, settingsDraft, type SettingsDraft } from "./settings";
import { Usage } from "./Usage";
import { Watch } from "./Watch";
import { Workspace } from "./Workspace";
import { Button, Card, Copy, ErrorLine, Loading, Outcome, Screen, ConfirmButton } from "./ui";

function Settings({ agent, refresh }: { agent: ReadableAgent; refresh: () => void }) {
  const client = useClient();
  const models = useResource<CatalogModel[]>("/api/admin/models");
  const operation = useOperation();
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const known = models.data?.some(
    (model) =>
      model.provider === agent.settings.model.provider &&
      model.modelId === agent.settings.model.modelId,
  );
  const choices = known
    ? (models.data ?? [])
    : [
        ...(models.data ?? []),
        {
          ...agent.settings.model,
          name: agent.settings.model.modelId,
          contextWindow: 0,
          thinkingLevels: agent.settings.thinkingLevel ? [agent.settings.thinkingLevel] : [],
        },
      ];
  const value = draft ?? settingsDraft(agent.settings);
  return (
    <>
      <Card>
        <Copy title>Agent 设置</Copy>
        <ErrorLine error={models.error} />
        <SettingsFields
          models={choices}
          value={value}
          onChange={(next) => {
            operation.reset();
            setDraft(next);
          }}
          disabled={operation.busy}
        />
        <Copy muted>从下一次模型请求起生效，已经开始的请求继续使用原设置。</Copy>
        <Outcome operation={operation} />
        <Button
          title="保存设置"
          primary
          disabled={operation.busy}
          onPress={() => {
            void operation
              .run(
                () =>
                  client.request(
                    `/api/admin/agents/${encodeURIComponent(agent.agentId)}/settings`,
                    "PUT",
                    settingsBody(value, choices),
                  ),
                "已保存，从下一次请求起生效。",
              )
              .then((ok) => {
                if (ok) {
                  setDraft(null);
                  refresh();
                }
              });
          }}
        />
      </Card>
      <NodeAccess agent={agent} refresh={refresh} />
      <Usage usage={agent.usage} />
    </>
  );
}
export function AgentDetail({ agentId }: { agentId: string }) {
  const client = useClient();
  const chat = useSessionChat();
  const agents = useResource<AgentView[]>("/api/admin/agents", 5000);
  const operation = useOperation();
  const [tab, setTab] = useState<"settings" | "watch" | "workspace">("settings");
  const agent = agents.data?.find((candidate) => candidate.agentId === agentId);
  if (tab === "watch" && agent?.state === "open")
    return <Watch agentId={agentId} onBack={() => setTab("settings")} />;
  return (
    <Screen onRefresh={agents.refresh} refreshing={agents.loading}>
      <ErrorLine error={agents.error} />
      <Loading loading={agents.loading && !agents.data} />
      {!agent && agents.data && <Copy>找不到这个 Agent，它可能已被删除。</Copy>}
      {agent && (
        <>
          <Copy title>{agent.displayName ?? agent.agentId}</Copy>
          <Copy muted>
            {agent.handle ? `@${agent.handle} · ` : ""}
            {stateLabel[agent.state]}
          </Copy>
          {agent.accountId !== undefined && (
            <Button
              title="发消息"
              disabled={operation.busy || !chat}
              onPress={() => {
                const other = agent.accountId;
                if (!chat || other === undefined) return;
                let conversationId: number | undefined;
                void operation
                  .run(async () => {
                    conversationId = (await chat.create({ kind: "dm", other })).conversationId;
                  }, "")
                  .then((ok) => {
                    if (ok && conversationId !== undefined && client.getSnapshot().kind === "ready")
                      router.push({
                        pathname: "/conversation",
                        params: { id: conversationId, sourceAgent: agentId },
                      });
                  });
              }}
            />
          )}
          {agent.state !== "unreadable" && (
            <>
              <Copy muted>主 Node · {agent.nodeName}</Copy>
              <Button
                title={agent.state === "open" ? "暂停 Agent" : "恢复 Agent"}
                disabled={operation.busy}
                onPress={() => {
                  void operation
                    .run(
                      () =>
                        client.request(
                          `/api/admin/agents/${encodeURIComponent(agentId)}/${agent.state === "open" ? "pause" : "resume"}`,
                          "POST",
                        ),
                      agent.state === "open" ? "Agent 已暂停。" : "Agent 已恢复。",
                    )
                    .then((ok) => {
                      if (ok) agents.refresh();
                    });
                }}
              />
            </>
          )}
          <ConfirmButton
            title="删除 Agent"
            danger
            disabled={operation.busy}
            question={`删除 ${agent.displayName ?? "Agent"}？`}
            message="设置和对话记录将被删除，聊天账号停用，无法恢复。已经发出的消息保留。"
            confirmLabel="删除"
            onConfirm={() => {
              void operation
                .run(
                  () =>
                    client.request(`/api/admin/agents/${encodeURIComponent(agentId)}`, "DELETE"),
                  "Agent 已删除。",
                )
                .then((ok) => {
                  if (ok) router.back();
                });
            }}
          />
          <Outcome operation={operation} />
          {agent.state === "unreadable" ? (
            <ErrorLine error={agent.problem} />
          ) : (
            <>
              <Button
                title={`${tab === "settings" ? "✓ " : ""}设置与用量`}
                onPress={() => setTab("settings")}
              />
              <Button
                title={`${tab === "watch" ? "✓ " : ""}观察`}
                onPress={() => setTab("watch")}
              />
              <Button
                title={`${tab === "workspace" ? "✓ " : ""}工作区`}
                onPress={() => setTab("workspace")}
              />
              {tab === "settings" && <Settings agent={agent} refresh={agents.refresh} />}
              {tab === "workspace" && <Workspace agentId={agentId} />}
              {tab === "watch" && <Copy muted>Agent 没有在运行，恢复后可以观察。</Copy>}
            </>
          )}
        </>
      )}
    </Screen>
  );
}
