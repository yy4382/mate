import type { AgentView, CatalogModel, NodeStatusResult } from "@mate/admin";
import { router } from "expo-router";
import { newAgentDraft, useAgentCreationDraft } from "./creation";
import { useClient, useOperation, useResource } from "./session";
import { settingsBody, SettingsFields } from "./settings";
import { Button, Card, Copy, ErrorLine, Field, Loading, Outcome, Screen, Select } from "./ui";

export const stateLabel: Record<AgentView["state"], string> = {
  open: "运行中",
  paused: "已暂停",
  closed: "已关闭",
  unreadable: "无法读取",
};
export type ReadableAgent = Exclude<AgentView, { state: "unreadable" }>;
export function AgentList() {
  const agents = useResource<AgentView[]>("/api/admin/agents", 5000);
  return (
    <Screen onRefresh={agents.refresh} refreshing={agents.loading}>
      <Copy muted>每个 Agent 有自己的上下文和工作区。</Copy>
      <Button title="创建 Agent" primary onPress={() => router.push("/agents/create")} />
      <ErrorLine error={agents.error} />
      <Loading loading={agents.loading && !agents.data} empty={agents.data?.length === 0} />
      {agents.data?.map((agent) => (
        <Card key={agent.agentId}>
          <Copy title>{agent.displayName ?? agent.agentId}</Copy>
          <Copy muted>
            {agent.handle ? `@${agent.handle} · ` : ""}
            {stateLabel[agent.state]}
          </Copy>
          {agent.state === "unreadable" ? (
            <ErrorLine error={agent.problem} />
          ) : (
            <>
              <Copy>
                {agent.settings.model.provider} / {agent.settings.model.modelId}
              </Copy>
              <Copy muted>主 Node · {agent.nodeName}</Copy>
            </>
          )}
          <Button
            title={`查看 ${agent.displayName ?? "Agent"}`}
            onPress={() => router.push({ pathname: "/agents/[id]", params: { id: agent.agentId } })}
          />
        </Card>
      ))}
    </Screen>
  );
}

export function CreateAgent() {
  const client = useClient();
  const nodes = useResource<NodeStatusResult[]>("/api/admin/nodes");
  const models = useResource<CatalogModel[]>("/api/admin/models");
  const operation = useOperation();
  const [draft, update] = useAgentCreationDraft();
  const { displayName, handle, nodeId, settings, attempt } = draft;
  const busy = operation.busy || attempt.kind === "pending";
  const node = nodes.data?.length === 1 ? nodes.data[0]?.nodeId : nodeId;
  return (
    <Screen>
      <Copy muted>给它起个名字，选择主 Node 和模型。主 Node 创建后不变。</Copy>
      <Card>
        <Field
          label="显示名"
          value={displayName}
          onChangeText={(displayName) => update((draft) => ({ ...draft, displayName }))}
          editable={!busy}
          maxLength={256}
        />
        <Field
          label="Handle"
          hint="登录名与 @ 名字，不能含空格。"
          value={handle}
          onChangeText={(handle) => update((draft) => ({ ...draft, handle }))}
          editable={!busy}
          maxLength={256}
        />
        <ErrorLine error={nodes.error} />
        <ErrorLine error={models.error} />
        <Loading loading={nodes.loading || models.loading} />
        {nodes.data?.length === 0 ? (
          <>
            <Copy>还没有配对的 Node。</Copy>
            <Button title="前往 Node 配对" onPress={() => router.push("/admin/nodes")} />
          </>
        ) : (
          <Select
            label="主 Node"
            value={node ?? ""}
            disabled={busy}
            options={(nodes.data ?? []).map((n) => ({
              value: n.nodeId,
              label: `${n.name}（${n.online ? "在线" : "离线"}）`,
            }))}
            onChange={(nodeId) => update((draft) => ({ ...draft, nodeId }))}
          />
        )}
        {models.data?.length === 0 ? (
          <>
            <Copy>没有可用模型，请先保存提供商凭据。</Copy>
            <Button title="配置模型提供商" onPress={() => router.push("/admin/providers")} />
          </>
        ) : (
          <SettingsFields
            models={models.data ?? []}
            value={settings}
            disabled={busy}
            onChange={(next) => {
              operation.reset();
              update((draft) => ({ ...draft, settings: next }));
            }}
          />
        )}
        <Outcome operation={operation} />
        {attempt.kind === "interrupted" && !busy && (
          <Copy muted>创建中断，继续时保留同一个 Agent ID。</Copy>
        )}
        <Button
          title={busy ? "正在创建…" : attempt.kind === "interrupted" ? "继续创建" : "创建"}
          primary
          disabled={busy || !node || !settings.model || !displayName.trim() || !handle.trim()}
          onPress={() => {
            if (!node) return;
            update((draft) => ({ ...draft, attempt: { ...draft.attempt, kind: "pending" } }));
            void operation
              .run(async () => {
                try {
                  await client.createAgent({
                    agentId: attempt.agentId,
                    nodeId: node,
                    displayName: displayName.trim(),
                    handle: handle.trim(),
                    settings: settingsBody(settings, models.data ?? []),
                  });
                  update(newAgentDraft);
                } catch (cause) {
                  update((draft) => ({
                    ...draft,
                    attempt: { ...draft.attempt, kind: "interrupted" },
                  }));
                  throw cause;
                }
              }, "Agent 已创建。")
              .then((ok) => {
                if (ok) router.back();
              });
          }}
        />
      </Card>
    </Screen>
  );
}
