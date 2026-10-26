import type { NodeStatusResult } from "@mate/admin";
import type { ReadableAgent } from "./Agents";
import { useClient, useOperation, useResource } from "./session";
import { Button, Card, Copy, ErrorLine, Loading, Outcome } from "./ui";

function NodeGrant({
  node,
  agent,
  refresh,
}: {
  node: NodeStatusResult;
  agent: ReadableAgent;
  refresh: () => void;
}) {
  const client = useClient();
  const operation = useOperation();
  const home = node.nodeId === agent.nodeId;
  const granted = agent.grantedNodes.some((grant) => grant.nodeId === node.nodeId);
  return (
    <Card>
      <Copy>
        {node.name} · {node.online ? "在线" : "离线"}
      </Copy>
      {home ? (
        <Copy muted>主 Node，始终可以访问。工作区和 MEMORY.md 在这里。</Copy>
      ) : (
        <>
          <Copy muted>{granted ? "已授权访问" : "尚未授权"}</Copy>
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
                    ? "已收回授权，已启动的命令继续运行。"
                    : "已授权，从下一次调用起可以访问。",
                )
                .then((ok) => {
                  if (ok) refresh();
                });
            }}
          />
          <Outcome operation={operation} />
        </>
      )}
    </Card>
  );
}
export function NodeAccess({ agent, refresh }: { agent: ReadableAgent; refresh: () => void }) {
  const nodes = useResource<NodeStatusResult[]>("/api/admin/nodes", 3000);
  return (
    <Card>
      <Copy title>Node 访问</Copy>
      <Copy muted>授权 Agent 访问其他 Node 上自己的工作区。授权和收回只影响之后开始的调用。</Copy>
      <ErrorLine error={nodes.error} />
      <Loading loading={nodes.loading && !nodes.data} />
      {nodes.data?.map((node) => (
        <NodeGrant key={node.nodeId} node={node} agent={agent} refresh={refresh} />
      ))}
    </Card>
  );
}
