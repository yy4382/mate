import type { NodeStatusResult } from "@mate/admin";
import * as Clipboard from "expo-clipboard";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PairingToken } from "./client";
import { useClient, useOperation, useResource } from "./session";
import { ErrorLine, Outcome, dateText } from "./ui";
import {
  Button,
  Card,
  Caption,
  Copy,
  Empty,
  Field,
  Loading,
  Row,
  Screen,
  Section,
  Sheet,
} from "../ui";

export function Nodes({
  onOpenNode = (id) => router.push({ pathname: "/admin/nodes/[id]", params: { id } }),
}: {
  onOpenNode?: (id: NodeStatusResult["nodeId"]) => void;
} = {}) {
  const client = useClient();
  const nodes = useResource<NodeStatusResult[]>("/api/admin/nodes", 3000);
  const operation = useOperation();
  const copy = useOperation();
  const [pairing, setPairing] = useState(false);
  const [token, setToken] = useState<PairingToken>();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!token) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(token.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [token]);
  const expired = !!token && now >= Date.parse(token.expiresAt);
  const command = token
    ? `mate node configure --control-plane ${client.server} --pairing-token ${token.pairingToken}`
    : "";
  const generate = () => {
    void operation.run(async () => {
      const next = await client.request<PairingToken>("/api/admin/pairing-tokens", "POST");
      setToken(next);
      copy.reset();
    }, "");
  };
  return (
    <Screen onRefresh={nodes.refresh} refreshing={nodes.loading}>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button onPress={() => setPairing(true)}>配对</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ErrorLine error={nodes.error} />
      {nodes.error != null && <Button title="重新读取" onPress={nodes.refresh} />}
      <Loading loading={nodes.loading && !nodes.data} />
      {nodes.data?.length === 0 && (
        <Empty
          title="还没有 Node"
          message="配对一台机器，让 Agent 在自己的工作区中执行命令和读写文件。"
        >
          <Button title="配对 Node" onPress={() => setPairing(true)} />
        </Empty>
      )}
      {!!nodes.data?.length && (
        <Section footer="Node 是 Agent 执行命令、读写文件的机器。">
          {nodes.data.map((n) => (
            <Row
              key={n.nodeId}
              title={n.name}
              subtitle={
                n.system
                  ? `${n.system.platform} · ${n.system.arch} · ${n.system.hostname}`
                  : "尚未收到系统信息"
              }
              value={n.online ? "在线" : "离线"}
              onPress={() => onOpenNode(n.nodeId)}
            />
          ))}
        </Section>
      )}
      <Sheet title="配对 Node" visible={pairing} onClose={() => setPairing(false)}>
        {token ? (
          <>
            <Caption>
              {expired
                ? "令牌已到期，请重新生成后使用。"
                : `一次性令牌，${dateText(token.expiresAt)} 前有效。`}
            </Caption>
            <Card>
              <Copy>在目标机器上运行</Copy>
              <Copy mono>{command}</Copy>
            </Card>
            <Button
              title="复制配对命令"
              primary
              disabled={expired || copy.busy}
              onPress={() =>
                void copy.run(() => Clipboard.setStringAsync(command), "配对命令已复制。")
              }
            />
            <Outcome operation={copy} />
            <Section title="手动配对">
              <Row title="配对令牌" subtitle={token.pairingToken} />
            </Section>
            <Button
              title="复制令牌"
              disabled={expired || copy.busy}
              onPress={() =>
                void copy.run(() => Clipboard.setStringAsync(token.pairingToken), "令牌已复制。")
              }
            />
            <Button
              title="查看 Node 列表"
              onPress={() => {
                setPairing(false);
                nodes.refresh();
              }}
            />
            <Caption>执行命令后，返回列表核对机器名字与在线状态。</Caption>
          </>
        ) : (
          <Copy>生成一次性令牌后，在目标机器运行配对命令。</Copy>
        )}
        <Outcome operation={operation} />
        <Button
          title={operation.busy ? "生成中…" : token ? "重新生成令牌" : "生成配对令牌"}
          primary={!token}
          disabled={operation.busy}
          onPress={generate}
        />
      </Sheet>
    </Screen>
  );
}

export function NodeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const client = useClient();
  const queries = useQueryClient();
  const nodes = useResource<NodeStatusResult[]>("/api/admin/nodes", 3000);
  const node = nodes.data?.find((n) => n.nodeId === id);
  const operation = useOperation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const valid = /^[a-z0-9][a-z0-9-]{0,31}$/.test(name);
  return (
    <Screen onRefresh={nodes.refresh} refreshing={nodes.loading}>
      <Stack.Screen options={{ title: node?.name ?? "Node 详情" }} />
      <ErrorLine error={nodes.error} />
      {nodes.error != null && <Button title="重新读取" onPress={nodes.refresh} />}
      <Loading loading={nodes.loading && !nodes.data} />
      {nodes.data && !node && (
        <Empty title="找不到这个 Node" message="返回列表查看当前已配对的机器。" />
      )}
      {node && (
        <>
          <Section title="连接">
            <Row title={node.name} value={node.online ? "在线" : "离线"} />
            <Row title="上次连接" subtitle={dateText(node.lastConnectedAt)} />
          </Section>
          <Section title="系统信息">
            {node.system ? (
              <>
                <Row title="系统" subtitle={`${node.system.platform} · ${node.system.osRelease}`} />
                <Row title="架构" value={node.system.arch} />
                <Row title="主机名" subtitle={node.system.hostname} />
                <Row title="Node 版本" subtitle={node.system.version} />
              </>
            ) : (
              <Row title="尚未收到系统信息" />
            )}
            <Row title="Node ID" subtitle={node.nodeId} />
          </Section>
          <Section>
            <Row
              title="修改名字"
              onPress={() => {
                setName(node.name);
                operation.reset();
                setEditing(true);
              }}
            />
          </Section>
          <Sheet title="修改 Node 名字" visible={editing} onClose={() => setEditing(false)}>
            <Caption>当前名字 · {node.name}</Caption>
            <Card>
              <Field
                label="Node 名字"
                hint="1 到 32 个小写字母、数字或 -，以字母或数字开头。"
                maxLength={32}
                value={name}
                onChangeText={(v) => {
                  operation.reset();
                  setName(v);
                }}
                editable={!operation.busy}
              />
              <Outcome operation={operation} />
            </Card>
            <Button
              title={operation.busy ? "保存中…" : "保存名字"}
              primary
              disabled={operation.busy || !valid}
              onPress={() => {
                void operation
                  .run(() =>
                    client.request(`/api/admin/nodes/${encodeURIComponent(id)}`, "PUT", { name }),
                  )
                  .then((ok) => {
                    if (ok) {
                      setEditing(false);
                      nodes.refresh();
                      void queries.invalidateQueries({ queryKey: ["/api/admin/agents"] });
                    }
                  });
              }}
            />
          </Sheet>
        </>
      )}
    </Screen>
  );
}
