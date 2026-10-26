import type { NodeStatusResult } from "@mate/admin";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import type { PairingToken } from "./client";
import { useClient, useOperation, useResource } from "./session";
import {
  Button,
  Card,
  Copy,
  ErrorLine,
  Fact,
  Field,
  Loading,
  Outcome,
  Screen,
  dateText,
} from "./ui";

function Node({ node, refresh }: { node: NodeStatusResult; refresh: () => void }) {
  const client = useClient();
  const operation = useOperation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(node.name);
  return (
    <Card>
      <Copy title>{node.name}</Copy>
      <Copy muted>{node.online ? "在线" : "离线"}</Copy>
      {node.system ? (
        <>
          <Fact label="系统" value={`${node.system.platform} · ${node.system.osRelease}`} />
          <Fact label="架构" value={node.system.arch} />
          <Fact label="主机名" value={node.system.hostname} />
          <Fact label="Node 版本" value={node.system.version} />
        </>
      ) : (
        <Copy muted>尚未收到系统信息。</Copy>
      )}
      <Fact label="上次连接" value={dateText(node.lastConnectedAt)} />
      <Copy mono muted>
        {node.nodeId}
      </Copy>
      {editing ? (
        <>
          <Field
            label="Node 名字"
            hint="1 到 32 个小写字母、数字或 -，以字母或数字开头。"
            maxLength={32}
            value={name}
            onChangeText={(value) => {
              operation.reset();
              setName(value);
            }}
            editable={!operation.busy}
          />
          <Button
            title="保存名字"
            primary
            disabled={operation.busy || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)}
            onPress={() => {
              void operation
                .run(() =>
                  client.request(`/api/admin/nodes/${encodeURIComponent(node.nodeId)}`, "PUT", {
                    name,
                  }),
                )
                .then((ok) => {
                  if (ok) {
                    setEditing(false);
                    refresh();
                  }
                });
            }}
          />
          <Button
            title="取消改名"
            disabled={operation.busy}
            onPress={() => {
              setName(node.name);
              setEditing(false);
              operation.reset();
            }}
          />
        </>
      ) : (
        <Button
          title={`修改 ${node.name} 名字`}
          onPress={() => {
            setName(node.name);
            operation.reset();
            setEditing(true);
          }}
        />
      )}
      <Outcome operation={operation} />
    </Card>
  );
}
export function Nodes() {
  const client = useClient();
  const nodes = useResource<NodeStatusResult[]>("/api/admin/nodes", 3000);
  const operation = useOperation();
  const copy = useOperation();
  const [token, setToken] = useState<PairingToken>();
  const command = token
    ? `mate node configure --control-plane ${client.server} --pairing-token ${token.pairingToken}`
    : "";
  return (
    <Screen onRefresh={nodes.refresh} refreshing={nodes.loading}>
      <Copy muted>Node 是 Agent 执行命令、读写文件的机器。配对后主动连接控制面。</Copy>
      <Button
        title="生成配对令牌"
        primary
        disabled={operation.busy}
        onPress={() => {
          void operation.run(async () => {
            setToken(await client.request<PairingToken>("/api/admin/pairing-tokens", "POST"));
            copy.reset();
          }, "令牌已生成。");
        }}
      />
      <Outcome operation={operation} />
      {token && (
        <Card>
          <Copy title>配对 Node</Copy>
          <Copy muted>只能使用一次，{dateText(token.expiresAt)} 前有效。</Copy>
          <Copy mono>{token.pairingToken}</Copy>
          <Button
            title="复制令牌"
            onPress={() =>
              void copy.run(() => Clipboard.setStringAsync(token.pairingToken), "令牌已复制。")
            }
          />
          <Copy>在 Node 所在机器上运行</Copy>
          <Copy mono>{command}</Copy>
          <Button
            title="复制配对命令"
            onPress={() => void copy.run(() => Clipboard.setStringAsync(command), "命令已复制。")}
          />
          <Outcome operation={copy} />
          <Button
            title="关闭配对信息"
            onPress={() => {
              setToken(undefined);
              operation.reset();
              copy.reset();
            }}
          />
        </Card>
      )}
      <ErrorLine error={nodes.error} />
      <Loading loading={nodes.loading && !nodes.data} empty={nodes.data?.length === 0} />
      {nodes.data?.map((node) => (
        <Node key={node.nodeId} node={node} refresh={nodes.refresh} />
      ))}
    </Screen>
  );
}
