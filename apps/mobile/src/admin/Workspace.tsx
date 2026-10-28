import { t } from "../i18n";
import type { ReactNode } from "react";
import type { AgentView, WorkspaceListing } from "@mate/admin";
import { router, Stack } from "expo-router";
import { Button, Caption, Copy, Empty, Row, Screen, Section } from "../ui";
import { ApiError } from "./client";
import { useManagementAccess, useResource } from "./session";
import { ErrorLine, Loading, bytesText } from "./ui";

export function Workspace({
  agentId,
  name,
  nodeName,
  path = ".",
  navigation,
}: {
  agentId: string;
  name: string;
  nodeName: string;
  path?: string;
  navigation?: ReactNode;
}) {
  const ready = useManagementAccess().kind === "ready";
  const result = useResource<WorkspaceListing>(
    `/api/admin/agents/${encodeURIComponent(agentId)}/workspace?path=${encodeURIComponent(path)}`,
  );
  const data = result.data;
  const open = (next: string) =>
    router.push({ pathname: "/agents/[id]/workspace", params: { id: agentId, path: next } });
  const outside = result.error instanceof ApiError && result.error.reason === "outside-workspace";
  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="arrow.clockwise"
          accessibilityLabel={t("management.reload_workspace")}
          hidden={!ready}
          disabled={result.loading}
          onPress={result.refresh}
        >
          {t("management.reload")}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Screen grouped={false} onRefresh={result.refresh} refreshing={result.loading}>
        {navigation}
        <Caption>{t("management.workspace_summary", { name, node: nodeName })}</Caption>
        <Section>
          <Row
            title={path === "." ? t("management.root_directory") : path}
            subtitle={path === "." ? "" : t("management.relative_to_the_agents_home_workspace")}
          />
          {path !== "." && <Row title={t("management.root_directory")} onPress={() => open(".")} />}
          {path !== "." && path.includes("/") && (
            <Row
              title={t("management.parent_directory")}
              onPress={() => open(path.split("/").slice(0, -1).join("/") || ".")}
            />
          )}
        </Section>
        <ErrorLine error={result.error} />
        {result.error != null && (
          <>
            {data && (
              <Caption>{t("management.showing_the_previously_loaded_content_the_current")}</Caption>
            )}
            {outside ? (
              <Button title={t("management.back_to_root")} onPress={() => open(".")} />
            ) : (
              <Button
                title={t("management.retry_loading")}
                disabled={result.loading}
                onPress={result.refresh}
              />
            )}
          </>
        )}
        <Loading loading={result.loading && !data} />
        {data?.kind === "directory" && (
          <Section
            footer={
              data.truncated
                ? t("management.this_directory_is_too_large_only_some")
                : t("management.sorted_by_name_the_workspace_can_still")
            }
          >
            {data.entries.length === 0 && <Empty title={t("management.empty_directory")} />}
            {data.entries.map((entry) => (
              <Row
                key={entry.name}
                title={entry.name}
                subtitle={
                  entry.kind === "directory"
                    ? t("management.directory")
                    : entry.kind === "symlink"
                      ? t("management.symbolic_link_target_must_be_within_the")
                      : ""
                }
                value={entry.kind === "file" ? bytesText(entry.size) : ""}
                onPress={() => open(path === "." ? entry.name : `${path}/${entry.name}`)}
              />
            ))}
          </Section>
        )}
        {data && data.kind !== "directory" && (
          <>
            <Caption>
              {data.kind === "file" && data.truncated
                ? t("management.truncated_size", { size: bytesText(data.size) })
                : bytesText(data.size)}
            </Caption>
            {data.kind === "file" ? (
              data.content.length ? (
                <Copy mono>{data.content}</Copy>
              ) : (
                <Empty title={t("management.empty_file")} />
              )
            ) : (
              <Empty
                title={t("management.binary_file")}
                message={t("management.only_the_size_is_available_this_file")}
              />
            )}
            {data.kind === "file" && data.truncated && (
              <Caption>{t("management.this_file_is_too_large_the_content")}</Caption>
            )}
          </>
        )}
      </Screen>
    </>
  );
}

export function AgentWorkspace({ agentId, path }: { agentId: string; path: string }) {
  const agents = useResource<AgentView[]>("/api/admin/agents", 5000);
  const agent = agents.data?.find((item) => item.agentId === agentId);
  return (
    <>
      <Stack.Screen
        options={{
          title:
            path === "."
              ? t("management.workspace")
              : (path.split("/").pop() ?? t("management.workspace")),
        }}
      />
      {agent && agent.state !== "unreadable" ? (
        <Workspace
          agentId={agentId}
          name={agent.displayName ?? t("chat.agent")}
          nodeName={agent.nodeName}
          path={path}
        />
      ) : (
        <Screen>
          <ErrorLine error={agents.error} />
          <Loading loading={agents.loading && !agents.data} />
          {agents.data && (
            <Empty
              title={agent ? t("management.cannot_read_agent") : t("management.agent_not_found")}
            />
          )}
          <Button title={t("management.reload_agent")} onPress={agents.refresh} />
        </Screen>
      )}
    </>
  );
}
