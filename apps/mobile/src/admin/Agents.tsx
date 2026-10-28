import { t } from "../i18n";
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
  open: t("management.running"),
  paused: t("management.paused"),
  closed: t("management.closed"),
  unreadable: t("management.unreadable"),
};
export type ReadableAgent = Exclude<AgentView, { state: "unreadable" }>;
export function AgentList() {
  const agents = useResource<AgentView[]>("/api/admin/agents", 5000);
  const ready = useManagementAccess().kind === "ready";
  const [draft, update] = useAgentCreationDraft();
  const { attempt } = draft;
  const create = () => {
    if (attempt.kind === "succeeded") update(newAgentDraft);
    router.push("/agents/create");
  };
  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="plus"
          accessibilityLabel={t("management.create_agent")}
          hidden={!ready}
          onPress={create}
        >
          {t("management.create_agent")}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Screen onRefresh={agents.refresh} refreshing={agents.loading}>
        <ErrorLine error={agents.error} />
        {agents.error != null && (
          <Button title={t("management.reload_agent")} onPress={agents.refresh} />
        )}
        {attempt.kind !== "new" && (
          <Section
            title={
              attempt.kind === "succeeded"
                ? t("management.created")
                : t("management.creation_progress")
            }
          >
            <Row
              title={attempt.input.displayName}
              subtitle={
                attempt.kind === "succeeded"
                  ? t("management.agent_created")
                  : attempt.kind === "pending"
                    ? t("management.creating_going_back_will_not_cancel_it")
                    : t("management.creation_is_unconfirmed_continue_the_original_operation")
              }
              onPress={() =>
                attempt.kind === "succeeded"
                  ? router.push({ pathname: "/agents/[id]", params: { id: attempt.agentId } })
                  : router.push("/agents/create")
              }
            />
          </Section>
        )}
        <Loading loading={agents.loading && !agents.data} />
        {agents.data?.length === 0 && !agents.loading && (
          <Empty
            title={t("management.no_agents_yet")}
            message={t("management.create_an_ai_colleague_with_its_own")}
          />
        )}
        {!!agents.data?.length && (
          <Section>
            {agents.data.map((agent) => (
              <Row
                key={agent.agentId}
                leading={
                  <Avatar name={agent.displayName ?? t("chat.agent")} kind="agent" size={40} />
                }
                title={agent.displayName ?? agent.agentId}
                subtitle={
                  agent.state === "unreadable"
                    ? t("management.unreadable_view_the_problem_and_available_actions")
                    : `@${agent.handle ?? t("management.unknown")} · ${agent.nodeName}`
                }
                value={stateLabel[agent.state]}
                accessibilityLabel={`${agent.displayName ?? agent.agentId}，${stateLabel[agent.state]}${agent.handle ? `，@${agent.handle}` : ""}`}
                onPress={() =>
                  router.push({ pathname: "/agents/[id]", params: { id: agent.agentId } })
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
          {busy
            ? t("management.creating")
            : attempt.kind === "interrupted"
              ? t("management.continue_creation")
              : t("management.create")}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Screen>
        <Outcome operation={operation} />
        {attempt.kind === "succeeded" ? (
          <Section title={t("management.agent_created")}>
            <Row
              title={attempt.input.displayName}
              subtitle={`@${attempt.input.handle}`}
              onPress={() =>
                router.replace({ pathname: "/agents/[id]", params: { id: attempt.agentId } })
              }
            />
            <Row
              title={t("management.create_another_agent")}
              onPress={() => update(newAgentDraft)}
            />
          </Section>
        ) : (
          <>
            {attempt.kind === "interrupted" && (
              <Section title={t("management.continue_the_original_creation")}>
                <View style={{ padding: 16, gap: 8 }}>
                  <Copy>{t("management.your_input_and_agent_id_are_kept")}</Copy>
                  <Caption>{attempt.agentId}</Caption>
                </View>
              </Section>
            )}
            <ErrorLine error={nodes.error ?? models.error} />
            {(nodes.error != null || models.error != null) && (
              <Button
                title={t("management.reload_runtime_configuration")}
                onPress={() => {
                  nodes.refresh();
                  models.refresh();
                }}
              />
            )}
            <Loading loading={(nodes.loading && !nodes.data) || (models.loading && !models.data)} />
            {(nodes.data?.length === 0 || models.data?.length === 0) && (
              <Section
                title={t("management.prepare_the_runtime_environment_first")}
                footer={t("management.return_after_setup_to_continue_this_draft")}
              >
                {nodes.data?.length === 0 && (
                  <Row
                    title={t("management.pair_node")}
                    subtitle={t("management.the_agent_needs_a_fixed_home_node")}
                    onPress={() => router.push("/agents/prerequisites/nodes")}
                  />
                )}
                {models.data?.length === 0 && (
                  <Row
                    title={t("management.configure_model_provider")}
                    subtitle={t("management.save_credentials_to_select_a_model")}
                    onPress={() => router.push("/agents/prerequisites/providers")}
                  />
                )}
              </Section>
            )}
            <Section title={t("management.identity")}>
              <View style={{ padding: 16, gap: 20 }}>
                <Field
                  label={t("settings.display_name")}
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
                  label={t("management.handle_mention_name")}
                  testID="agent-handle"
                  hint={t("management.handle_hint", { handle: handle || "handle" })}
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
                  label={t("management.home_node")}
                  value={node ?? ""}
                  disabled={locked}
                  options={(nodes.data ?? []).map((n) => ({
                    value: n.nodeId,
                    label: `${n.name} · ${n.online ? t("management.online") : t("management.offline")}`,
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
