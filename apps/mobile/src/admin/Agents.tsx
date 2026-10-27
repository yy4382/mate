import type { AgentView, CatalogModel, NodeStatusResult } from "@mate/admin";
import { router, Stack, useIsFocused } from "expo-router";
import { useEffect, useRef } from "react";
import { View } from "react-native";
import { Avatar, Button, Caption, Empty, Field, Row, Screen, Section, Select } from "../ui";
import { newAgentDraft, useAgentCreationDraft } from "./creation";
import { ApiError } from "./client";
import { useClient, useManagementAccess, useOperation, useResource } from "./session";
import { settingsBody, SettingsFields } from "./settings";
import { Copy, ErrorLine, Loading, Outcome } from "./ui";

export const stateLabel: Record<AgentView["state"], string> = {
  open: "运行中",
  paused: "已暂停",
  closed: "已关闭",
  unreadable: "无法读取",
};
export type ReadableAgent = Exclude<AgentView, { state: "unreadable" }>;
export function AgentList() {
  const agents = useResource<AgentView[]>("/api/admin/agents", 5000);
  const ready = useManagementAccess().kind === "ready";
  const [draft, update] = useAgentCreationDraft();
  const { attempt } = draft;
  const create = () => {
    if (attempt.kind === "succeeded") update(newAgentDraft);
    router.push("/admin/agents/create");
  };
  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="plus"
          accessibilityLabel="创建 Agent"
          hidden={!ready}
          onPress={create}
        >
          创建 Agent
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Screen onRefresh={agents.refresh} refreshing={agents.loading}>
        <ErrorLine error={agents.error} />
        {agents.error != null && <Button title="重新读取 Agent" onPress={agents.refresh} />}
        {attempt.kind !== "new" && (
          <Section title={attempt.kind === "succeeded" ? "已创建" : "创建进度"}>
            <Row
              title={attempt.input.displayName}
              subtitle={
                attempt.kind === "succeeded"
                  ? "Agent 已创建"
                  : attempt.kind === "pending"
                    ? "正在创建，返回不会取消"
                    : "创建结果尚未确认，继续原操作"
              }
              onPress={() =>
                attempt.kind === "succeeded"
                  ? router.push({ pathname: "/admin/agents/[id]", params: { id: attempt.agentId } })
                  : router.push("/admin/agents/create")
              }
            />
          </Section>
        )}
        <Loading loading={agents.loading && !agents.data} />
        {agents.data?.length === 0 && !agents.loading && (
          <Empty title="还没有 Agent" message="创建一个有自己上下文和工作区的 AI 同事。" />
        )}
        {!!agents.data?.length && (
          <Section>
            {agents.data.map((agent) => (
              <Row
                key={agent.agentId}
                leading={<Avatar name={agent.displayName ?? "Agent"} kind="agent" size={40} />}
                title={agent.displayName ?? agent.agentId}
                subtitle={
                  agent.state === "unreadable"
                    ? "无法读取 · 查看问题与可用操作"
                    : `@${agent.handle ?? "未知"} · ${agent.nodeName}`
                }
                value={stateLabel[agent.state]}
                accessibilityLabel={`${agent.displayName ?? agent.agentId}，${stateLabel[agent.state]}${agent.handle ? `，@${agent.handle}` : ""}`}
                onPress={() =>
                  router.push({ pathname: "/admin/agents/[id]", params: { id: agent.agentId } })
                }
              />
            ))}
          </Section>
        )}
      </Screen>
    </>
  );
}

export function CreateAgent() {
  const client = useClient();
  const ready = useManagementAccess().kind === "ready";
  const nodes = useResource<NodeStatusResult[]>("/api/admin/nodes");
  const models = useResource<CatalogModel[]>("/api/admin/models");
  const operation = useOperation();
  const [draft, update] = useAgentCreationDraft();
  const focused = useIsFocused();
  const focus = useRef(focused);
  useEffect(() => {
    focus.current = focused;
  }, [focused]);
  const { displayName, handle, nodeId, settings, attempt } = draft;
  const busy = operation.busy || attempt.kind === "pending";
  const locked = attempt.kind !== "new";
  const node = nodeId || (nodes.data?.length === 1 ? nodes.data[0]?.nodeId : undefined);
  const submit = () => {
    if (busy || !ready || attempt.kind === "succeeded") return;
    void operation
      .run(async () => {
        const input =
          attempt.kind === "interrupted"
            ? attempt.input
            : {
                agentId: attempt.agentId,
                nodeId: node ?? "",
                displayName: displayName.trim(),
                handle: handle.trim(),
                settings: settingsBody(settings, models.data ?? []),
              };
        update((current) => ({
          ...current,
          attempt: { kind: "pending", agentId: input.agentId, input },
        }));
        try {
          await client.createAgent(input);
          update((current) => ({
            ...current,
            attempt: { kind: "succeeded", agentId: input.agentId, input },
          }));
        } catch (cause) {
          const refused =
            cause instanceof ApiError &&
            cause.status >= 400 &&
            cause.status < 500 &&
            cause.reason !== "agent-exists";
          update((current) => ({
            ...current,
            attempt: refused
              ? { kind: "new", agentId: input.agentId }
              : { kind: "interrupted", agentId: input.agentId, input },
          }));
          throw cause;
        }
      }, "")
      .then((ok) => {
        if (ok && focus.current && client.getSnapshot().kind === "ready") router.back();
      });
  };
  const disabled =
    !ready ||
    busy ||
    attempt.kind === "succeeded" ||
    (attempt.kind === "new" && (!node || !settings.model || !displayName.trim() || !handle.trim()));
  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button hidden={!ready} disabled={disabled} onPress={submit}>
          {busy ? "创建中…" : attempt.kind === "interrupted" ? "继续创建" : "创建"}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Screen>
        <Outcome operation={operation} />
        {attempt.kind === "succeeded" ? (
          <Section title="Agent 已创建">
            <Row
              title={attempt.input.displayName}
              subtitle={`@${attempt.input.handle}`}
              onPress={() =>
                router.replace({ pathname: "/admin/agents/[id]", params: { id: attempt.agentId } })
              }
            />
            <Row title="创建另一个 Agent" onPress={() => update(newAgentDraft)} />
          </Section>
        ) : (
          <>
            {attempt.kind === "interrupted" && (
              <Section title="继续原来的创建">
                <View style={{ padding: 16, gap: 8 }}>
                  <Copy>输入和 Agent ID 已保留。继续时会核对原操作的结果。</Copy>
                  <Caption>{attempt.agentId}</Caption>
                </View>
              </Section>
            )}
            <ErrorLine error={nodes.error ?? models.error} />
            {(nodes.error != null || models.error != null) && (
              <Button
                title="重新读取运行配置"
                onPress={() => {
                  nodes.refresh();
                  models.refresh();
                }}
              />
            )}
            <Loading loading={(nodes.loading && !nodes.data) || (models.loading && !models.data)} />
            {(nodes.data?.length === 0 || models.data?.length === 0) && (
              <Section title="先准备运行环境" footer="完成配置后返回，继续填写这份草稿。">
                {nodes.data?.length === 0 && (
                  <Row
                    title="配对 Node"
                    subtitle="Agent 需要一个固定的主 Node"
                    onPress={() => router.push("/admin/agents/prerequisites/nodes")}
                  />
                )}
                {models.data?.length === 0 && (
                  <Row
                    title="配置模型提供商"
                    subtitle="保存凭据后即可选择模型"
                    onPress={() => router.push("/admin/agents/prerequisites/providers")}
                  />
                )}
              </Section>
            )}
            <Section title="身份">
              <View style={{ padding: 16, gap: 20 }}>
                <Field
                  label="显示名"
                  testID="agent-display-name"
                  value={displayName}
                  onChangeText={(displayName) => {
                    operation.reset();
                    update((current) => ({ ...current, displayName }));
                  }}
                  editable={!locked}
                  maxLength={256}
                />
                <Field
                  label="Handle · 提及名称"
                  testID="agent-handle"
                  hint={`提及时使用 @${handle || "handle"}，不能包含空格。`}
                  value={handle}
                  onChangeText={(handle) => {
                    operation.reset();
                    update((current) => ({ ...current, handle }));
                  }}
                  editable={!locked}
                  maxLength={256}
                />
              </View>
            </Section>
            <SettingsFields
              models={models.data ?? []}
              value={settings}
              disabled={locked}
              onChange={(settings) => {
                operation.reset();
                update((current) => ({ ...current, settings }));
              }}
              node={
                <Select
                  label="主 Node"
                  value={node ?? ""}
                  disabled={locked}
                  options={(nodes.data ?? []).map((n) => ({
                    value: n.nodeId,
                    label: `${n.name} · ${n.online ? "在线" : "离线"}`,
                  }))}
                  onChange={(nodeId) => update((current) => ({ ...current, nodeId }))}
                />
              }
            />
          </>
        )}
      </Screen>
    </>
  );
}
