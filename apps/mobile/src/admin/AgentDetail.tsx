import type { AgentView, CatalogModel } from "@mate/admin";
import { router, Stack, useIsFocused } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useSessionChat } from "../session";
import { useTheme } from "../theme";
import {
  Avatar,
  Button,
  Caption,
  Copy,
  Empty,
  Row,
  Screen,
  Section,
  Segmented,
  Sheet,
} from "../ui";
import { stateLabel, type ReadableAgent } from "./Agents";
import { NodeAccess } from "./NodeAccess";
import { useClient, useManagementAccess, useOperation, useResource } from "./session";
import { SettingsFields, settingsBody, settingsDraft, type SettingsDraft } from "./settings";
import { Usage } from "./Usage";
import { Watch } from "./Watch";
import { Workspace } from "./Workspace";
import { ErrorLine, Loading, Outcome } from "./ui";

type Destination = "settings" | "access" | "usage";
function Settings({ agent, refresh }: { agent: ReadableAgent; refresh(): void }) {
  const client = useClient();
  const ready = useManagementAccess().kind === "ready";
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
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          hidden={!ready}
          disabled={operation.busy || !draft}
          onPress={() => {
            void operation
              .run(
                () =>
                  client.request(
                    `/api/admin/agents/${encodeURIComponent(agent.agentId)}/settings`,
                    "PUT",
                    settingsBody(value, choices),
                  ),
                "已保存，从下一次模型请求起生效。",
              )
              .then((ok) => {
                if (ok) {
                  setDraft(null);
                  refresh();
                }
              });
          }}
        >
          {operation.busy ? "保存中…" : "保存"}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Screen>
        <Caption>{agent.displayName ?? agent.agentId}</Caption>
        <ErrorLine error={models.error} />
        {models.error != null && <Button title="重新读取模型目录" onPress={models.refresh} />}
        <SettingsFields
          models={choices}
          value={value}
          onChange={(next) => {
            operation.reset();
            setDraft(next);
          }}
          disabled={operation.busy}
        />
        <Outcome operation={operation} />
        <Section title="身份与归属" footer="显示名、Handle 和主 Node 在这里仅供查看。">
          <Row title="显示名" value={agent.displayName ?? "未知"} />
          <Row title="Handle" value={agent.handle ? `@${agent.handle}` : "未知"} />
          <Row title="主 Node" value={agent.nodeName} />
        </Section>
      </Screen>
    </>
  );
}
export function AgentDestination({
  agentId,
  destination,
}: {
  agentId: string;
  destination: Destination;
}) {
  const agents = useResource<AgentView[]>("/api/admin/agents", 5000);
  const agent = agents.data?.find((candidate) => candidate.agentId === agentId);
  if (agent && agent.state !== "unreadable") {
    if (destination === "settings") return <Settings agent={agent} refresh={agents.refresh} />;
    return (
      <Screen onRefresh={agents.refresh} refreshing={agents.loading}>
        <Caption>{agent.displayName ?? agentId}</Caption>
        <ErrorLine error={agents.error} />
        {destination === "access" ? (
          <NodeAccess agent={agent} refresh={agents.refresh} />
        ) : (
          <Usage usage={agent.usage} />
        )}
      </Screen>
    );
  }
  return (
    <Screen>
      <ErrorLine error={agents.error} />
      <Loading loading={agents.loading && !agents.data} />
      {agents.data && (
        <Empty
          title={agent ? "无法读取 Agent" : "找不到这个 Agent"}
          message={agent ? "返回总览查看问题详情。" : "它可能已被删除。"}
        />
      )}
      <Button title="重新读取 Agent" onPress={agents.refresh} />
    </Screen>
  );
}

export function AgentDetail({ agentId }: { agentId: string }) {
  const client = useClient();
  const chat = useSessionChat();
  const ready = useManagementAccess().kind === "ready";
  const c = useTheme();
  const agents = useResource<AgentView[]>("/api/admin/agents", 5000);
  const operation = useOperation();
  const [tab, setTab] = useState<"总览" | "观察" | "工作区">("总览");
  const [management, setManagement] = useState<"menu" | "delete" | null>(null);
  const focused = useIsFocused();
  const focus = useRef(focused);
  useEffect(() => {
    focus.current = focused;
  }, [focused]);
  const agent = agents.data?.find((candidate) => candidate.agentId === agentId);
  const name = agent?.displayName ?? "Agent";
  const lifecycle = () => {
    if (!agent || agent.state === "unreadable" || !ready) return;
    setManagement(null);
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
  };
  const destination = (page: Destination) => {
    const paths = {
      settings: "/agents/[id]/settings",
      access: "/agents/[id]/access",
      usage: "/agents/[id]/usage",
    } as const;
    router.push({ pathname: paths[page], params: { id: agentId } });
  };
  const navigation = agent && agent.state !== "unreadable" && (
    <Segmented value={tab} options={["总览", "观察", "工作区"] as const} onChange={setTab} />
  );
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen
        options={{
          title: tab === "总览" ? name : tab === "观察" ? `观察 · ${name}` : "工作区",
          headerLargeTitle: false,
        }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="ellipsis"
          accessibilityLabel={`管理 ${name}`}
          hidden={!ready || !agent}
          onPress={() => setManagement("menu")}
        >
          管理 Agent
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      {tab === "观察" && agent && agent.state !== "unreadable" ? (
        agent.state === "open" ? (
          <Watch agentId={agentId} name={name} navigation={navigation} />
        ) : (
          <Screen grouped={false}>
            {navigation}
            <Empty
              title={stateLabel[agent.state]}
              message="恢复后可以观察主对话和工作助手。工作区仍可阅读。"
            >
              <Button title="恢复 Agent" disabled={operation.busy} onPress={lifecycle} />
            </Empty>
            <Outcome operation={operation} />
          </Screen>
        )
      ) : tab === "工作区" && agent && agent.state !== "unreadable" ? (
        <Workspace
          agentId={agentId}
          name={name}
          nodeName={agent.nodeName}
          navigation={navigation}
        />
      ) : (
        <Screen grouped={false} onRefresh={agents.refresh} refreshing={agents.loading}>
          {navigation}
          <ErrorLine error={agents.error} />
          <Loading loading={agents.loading && !agents.data} />
          {!agent && agents.data && (
            <Empty title="找不到这个 Agent" message="它可能已被删除。">
              <Button title="返回 Agent 列表" onPress={() => router.replace("/agents")} />
            </Empty>
          )}
          {agents.error != null && <Button title="重新读取 Agent" onPress={agents.refresh} />}
          {agent && (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
                <Avatar name={name} kind="agent" size={48} />
                <View style={{ flex: 1, gap: 4 }}>
                  <Copy>{agent.handle ? `@${agent.handle}` : agentId}</Copy>
                  <Caption>{stateLabel[agent.state]}</Caption>
                </View>
              </View>
              {agent.state !== "unreadable" && agent.state !== "open" && (
                <Button title="恢复 Agent" primary disabled={operation.busy} onPress={lifecycle} />
              )}
              {agent.accountId !== undefined && (
                <Button
                  title="发消息"
                  primary={agent.state === "open"}
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
                        if (
                          ok &&
                          focus.current &&
                          conversationId !== undefined &&
                          client.getSnapshot().kind === "ready"
                        )
                          router.push({
                            pathname: "/conversation",
                            params: { id: conversationId, sourceAgent: agentId },
                          });
                      });
                  }}
                />
              )}
              <Outcome operation={operation} />
              {agent.state === "unreadable" ? (
                <ErrorLine error={agent.problem} />
              ) : (
                <>
                  <Section title="运行环境">
                    <Row
                      title="模型"
                      subtitle={`${agent.settings.model.provider} / ${agent.settings.model.modelId}`}
                    />
                    <Row title="主 Node" value={agent.nodeName} />
                  </Section>
                  <Section title="管理">
                    <Row
                      title="设置"
                      subtitle="模型、思考级别与说明文字"
                      onPress={() => destination("settings")}
                    />
                    <Row title="Node 访问" onPress={() => destination("access")} />
                    <Row title="用量" onPress={() => destination("usage")} />
                  </Section>
                </>
              )}
            </>
          )}
        </Screen>
      )}
      <Sheet
        visible={management === "menu" && !!agent}
        title={`管理 ${name}`}
        onClose={() => setManagement(null)}
      >
        <Section>
          {agent && agent.state !== "unreadable" && (
            <Row
              title={agent.state === "open" ? "暂停 Agent" : "恢复 Agent"}
              subtitle={
                agent.state === "open" ? "中止当前工作，之后可以恢复" : "从保存的上下文继续"
              }
              disabled={operation.busy}
              onPress={lifecycle}
            />
          )}
          <Row
            title="删除 Agent…"
            danger
            disabled={operation.busy}
            onPress={() => setManagement("delete")}
          />
        </Section>
        <Caption>Agent ID</Caption>
        <Copy mono>{agentId}</Copy>
      </Sheet>
      <Sheet
        visible={management === "delete" && !!agent}
        title={`删除 ${name}？`}
        onClose={() => setManagement(null)}
      >
        <Copy>
          设置和 Agent 对话记录将被删除，聊天账号永久停用。已经发出的聊天消息保留。此操作无法恢复。
        </Copy>
        <Button
          title={`删除 ${name}`}
          primary
          danger
          disabled={operation.busy || !ready}
          onPress={() => {
            setManagement(null);
            void operation
              .run(
                () => client.request(`/api/admin/agents/${encodeURIComponent(agentId)}`, "DELETE"),
                "Agent 已删除。",
              )
              .then((ok) => {
                if (ok && focus.current) router.back();
              });
          }}
        />
        <Button title="取消" onPress={() => setManagement(null)} />
      </Sheet>
    </View>
  );
}
