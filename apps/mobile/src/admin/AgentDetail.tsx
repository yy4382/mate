import { t } from "../i18n";
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
                t("management.saved_changes_take_effect_with_the_next"),
              )
              .then((ok) => {
                if (ok) {
                  setDraft(null);
                  refresh();
                }
              });
          }}
        >
          {operation.busy ? t("settings.saving") : t("settings.save")}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Screen>
        <Caption>{agent.displayName ?? agent.agentId}</Caption>
        <ErrorLine error={models.error} />
        {models.error != null && (
          <Button title={t("management.reload_model_catalog")} onPress={models.refresh} />
        )}
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
        <Section
          title={t("management.identity_and_home_node")}
          footer={t("management.display_name_handle_and_home_node_are")}
        >
          <Row
            title={t("settings.display_name")}
            value={agent.displayName ?? t("management.unknown")}
          />
          <Row
            title={t("settings.handle")}
            value={agent.handle ? `@${agent.handle}` : t("management.unknown")}
          />
          <Row title={t("management.home_node")} value={agent.nodeName} />
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
          title={agent ? t("management.cannot_read_agent") : t("management.agent_not_found")}
          message={
            agent
              ? t("management.return_to_the_overview_to_see_the")
              : t("management.it_may_have_been_deleted")
          }
        />
      )}
      <Button title={t("management.reload_agent")} onPress={agents.refresh} />
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
  const [tab, setTab] = useState<"overview" | "observe" | "workspace">("overview");
  const [management, setManagement] = useState<"menu" | "delete" | null>(null);
  const focused = useIsFocused();
  const focus = useRef(focused);
  useEffect(() => {
    focus.current = focused;
  }, [focused]);
  const agent = agents.data?.find((candidate) => candidate.agentId === agentId);
  const name = agent?.displayName ?? t("chat.agent");
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
        agent.state === "open" ? t("management.agent_paused") : t("management.agent_resumed"),
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
    <Segmented
      value={tab}
      options={["overview", "observe", "workspace"] as const}
      labels={{
        overview: t("management.overview"),
        observe: t("management.observe"),
        workspace: t("management.workspace"),
      }}
      onChange={setTab}
    />
  );
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen
        options={{
          title:
            tab === "overview"
              ? name
              : tab === "observe"
                ? t("management.observe_name", { name: name })
                : t("management.workspace"),
          headerLargeTitle: false,
        }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="ellipsis"
          accessibilityLabel={t("management.manage_name", { name: name })}
          hidden={!ready || !agent}
          onPress={() => setManagement("menu")}
        >
          {t("management.manage_agent")}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      {tab === "observe" && agent && agent.state !== "unreadable" ? (
        agent.state === "open" ? (
          <Watch agentId={agentId} name={name} navigation={navigation} />
        ) : (
          <Screen grouped={false}>
            {navigation}
            <Empty
              title={stateLabel[agent.state]}
              message={t("management.resume_to_observe_the_main_conversation_and")}
            >
              <Button
                title={t("management.resume_agent")}
                disabled={operation.busy}
                onPress={lifecycle}
              />
            </Empty>
            <Outcome operation={operation} />
          </Screen>
        )
      ) : tab === "workspace" && agent && agent.state !== "unreadable" ? (
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
            <Empty
              title={t("management.agent_not_found")}
              message={t("management.it_may_have_been_deleted")}
            >
              <Button
                title={t("management.back_to_agent_list")}
                onPress={() => router.replace("/agents")}
              />
            </Empty>
          )}
          {agents.error != null && (
            <Button title={t("management.reload_agent")} onPress={agents.refresh} />
          )}
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
                <Button
                  title={t("management.resume_agent")}
                  primary
                  disabled={operation.busy}
                  onPress={lifecycle}
                />
              )}
              {agent.accountId !== undefined && (
                <Button
                  title={t("management.message")}
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
                  <Section title={t("management.runtime_environment")}>
                    <Row
                      title={t("management.models")}
                      subtitle={`${agent.settings.model.provider} / ${agent.settings.model.modelId}`}
                    />
                    <Row title={t("management.home_node")} value={agent.nodeName} />
                  </Section>
                  <Section title={t("management.manage")}>
                    <Row
                      title={t("management.settings")}
                      subtitle={t("management.model_thinking_level_and_instructions")}
                      onPress={() => destination("settings")}
                    />
                    <Row
                      title={t("management.node_access")}
                      onPress={() => destination("access")}
                    />
                    <Row title={t("management.usage")} onPress={() => destination("usage")} />
                  </Section>
                </>
              )}
            </>
          )}
        </Screen>
      )}
      <Sheet
        visible={management === "menu" && !!agent}
        title={t("management.manage_name", { name: name })}
        onClose={() => setManagement(null)}
      >
        <Section>
          {agent && agent.state !== "unreadable" && (
            <Row
              title={
                agent.state === "open" ? t("management.pause_agent") : t("management.resume_agent")
              }
              subtitle={
                agent.state === "open"
                  ? t("management.stop_current_work_it_can_be_resumed")
                  : t("management.continue_from_the_saved_context")
              }
              disabled={operation.busy}
              onPress={lifecycle}
            />
          )}
          <Row
            title={t("management.delete_agent")}
            danger
            disabled={operation.busy}
            onPress={() => setManagement("delete")}
          />
        </Section>
        <Caption>{t("management.agent_id")}</Caption>
        <Copy mono>{agentId}</Copy>
      </Sheet>
      <Sheet
        visible={management === "delete" && !!agent}
        title={t("management.delete_question", { name: name })}
        onClose={() => setManagement(null)}
      >
        <Copy>{t("management.settings_and_agent_conversation_records_will_be")}</Copy>
        <Button
          title={t("management.delete_name", { name: name })}
          primary
          danger
          disabled={operation.busy || !ready}
          onPress={() => {
            setManagement(null);
            void operation
              .run(
                () => client.request(`/api/admin/agents/${encodeURIComponent(agentId)}`, "DELETE"),
                t("management.agent_deleted"),
              )
              .then((ok) => {
                if (ok && focus.current) router.back();
              });
          }}
        />
        <Button title={t("common.cancel")} onPress={() => setManagement(null)} />
      </Sheet>
    </View>
  );
}
