import type { NodeStatusResult } from "@mate/admin";
import { View } from "react-native";
import type { ReadableAgent } from "./Agents";
import { Button, Caption, Copy, Row, Section } from "../ui";
import { useClient, useOperation, useResource } from "./session";
import { ErrorLine, Loading, Outcome } from "./ui";

function NodeGrant({
  node,
  agent,
  refresh,
}: {
  node: NodeStatusResult;
  agent: ReadableAgent;
  refresh(): void;
}) {
  const client = useClient();
  const operation = useOperation();
  const home = node.nodeId === agent.nodeId;
  const granted = agent.grantedNodes.some((grant) => grant.nodeId === node.nodeId);
  return (
    <View>
      <Row
        title={node.name}
        subtitle={`${node.online ? "在线" : "离线"}${node.system ? ` · ${node.system.platform} / ${node.system.arch}` : ""}`}
        value={home ? "主 Node" : granted ? "已授权" : "未授权"}
      />
      <View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 8 }}>
        {home ? (
          <Caption>固定可访问，主工作区和 MEMORY.md 在这里。</Caption>
        ) : (
          <>
            {!node.online && granted && (
              <Caption>访问权已生效，工作区准备会在 Node 在线后进行。</Caption>
            )}
            <Button
              title={`${granted ? "收回" : "授权"} ${node.name} 访问`}
              disabled={operation.busy}
              onPress={() => {
                void operation
                  .run(
                    () =>
                      client.request(
                        `/api/admin/agents/${encodeURIComponent(agent.agentId)}/nodes/${encodeURIComponent(node.nodeId)}`,
                        granted ? "DELETE" : "PUT",
                      ),
                    granted
                      ? "已收回授权。已启动的命令继续运行，工作区保留。"
                      : node.online
                        ? "访问权已生效，从下一次调用起可以访问。"
                        : "访问权已生效。离线 Node 的工作区准备延后进行。",
                  )
                  .then((ok) => {
                    if (ok) refresh();
                  });
              }}
            />
            <Outcome operation={operation} />
          </>
        )}
      </View>
    </View>
  );
}
export function NodeAccess({ agent, refresh }: { agent: ReadableAgent; refresh(): void }) {
  const nodes = useResource<NodeStatusResult[]>("/api/admin/nodes", 3000);
  return (
    <>
      <Copy muted>允许 Agent 访问其他 Node 上自己的工作区。授权和收回只影响之后开始的调用。</Copy>
      <ErrorLine error={nodes.error} />
      {nodes.error != null && <Button title="重新读取 Node" onPress={nodes.refresh} />}
      <Loading loading={nodes.loading && !nodes.data} />
      <Section title="已配对的 Node" footer="收回访问不会删除文件，也不会中止已经开始的命令。">
        {nodes.data?.map((node) => (
          <NodeGrant key={node.nodeId} node={node} agent={agent} refresh={refresh} />
        ))}
      </Section>
    </>
  );
}
