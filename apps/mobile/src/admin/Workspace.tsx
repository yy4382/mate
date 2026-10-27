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
          accessibilityLabel="重新读取工作区"
          hidden={!ready}
          disabled={result.loading}
          onPress={result.refresh}
        >
          重新读取
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Screen grouped={false} onRefresh={result.refresh} refreshing={result.loading}>
        {navigation}
        <Caption>
          {name} · 主 Node {nodeName} · 只读
        </Caption>
        <Section>
          <Row
            title={path === "." ? "根目录" : path}
            subtitle={path === "." ? "" : "相对于 Agent 主工作区"}
          />
          {path !== "." && <Row title="根目录" onPress={() => open(".")} />}
          {path !== "." && path.includes("/") && (
            <Row
              title="上一级"
              onPress={() => open(path.split("/").slice(0, -1).join("/") || ".")}
            />
          )}
        </Section>
        <ErrorLine error={result.error} />
        {result.error != null && (
          <>
            {data && <Caption>以下为上次读取的内容，当前结果尚未更新。</Caption>}
            {outside ? (
              <Button title="返回根目录" onPress={() => open(".")} />
            ) : (
              <Button title="重试读取" disabled={result.loading} onPress={result.refresh} />
            )}
          </>
        )}
        <Loading loading={result.loading && !data} />
        {data?.kind === "directory" && (
          <Section
            footer={
              data.truncated
                ? "目录过大，只列出了部分条目。"
                : "按名称排列。Agent 暂停时仍可阅读工作区。"
            }
          >
            {data.entries.length === 0 && <Empty title="空目录" />}
            {data.entries.map((entry) => (
              <Row
                key={entry.name}
                title={entry.name}
                subtitle={
                  entry.kind === "directory"
                    ? "目录"
                    : entry.kind === "symlink"
                      ? "符号链接 · 目标需位于工作区内"
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
              {bytesText(data.size)}
              {data.kind === "file" && data.truncated ? " · 仅显示文件开头" : ""}
            </Caption>
            {data.kind === "file" ? (
              data.content.length ? (
                <Copy mono>{data.content}</Copy>
              ) : (
                <Empty title="空文件" />
              )
            ) : (
              <Empty title="二进制文件" message="此文件只有大小信息，无法预览内容。" />
            )}
            {data.kind === "file" && data.truncated && (
              <Caption>文件过大，当前内容已截断。</Caption>
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
        options={{ title: path === "." ? "工作区" : (path.split("/").pop() ?? "工作区") }}
      />
      {agent && agent.state !== "unreadable" ? (
        <Workspace
          agentId={agentId}
          name={agent.displayName ?? "Agent"}
          nodeName={agent.nodeName}
          path={path}
        />
      ) : (
        <Screen>
          <ErrorLine error={agents.error} />
          <Loading loading={agents.loading && !agents.data} />
          {agents.data && <Empty title={agent ? "无法读取 Agent" : "找不到这个 Agent"} />}
          <Button title="重新读取 Agent" onPress={agents.refresh} />
        </Screen>
      )}
    </>
  );
}
