import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentView } from "@mate/admin";
import { del, put } from "../shell/api.ts";
import {
  Badge,
  Button,
  Card,
  CardBody,
  ErrorLine,
  StatusDot,
  cx,
  feedbackClass,
} from "../shell/ui.tsx";
import { adminKeys, useNodes, type NodeView } from "./data.ts";

type ReadableAgent = Exclude<AgentView, { state: "unreadable" }>;

function NodeAccessRow({ agent, node }: { agent: ReadableAgent; node: NodeView }) {
  const qc = useQueryClient();
  const home = node.nodeId === agent.nodeId;
  const granted = agent.grantedNodes.some((grant) => grant.nodeId === node.nodeId);
  const change = useMutation({
    mutationFn: (allow: boolean) => {
      const path = `/api/admin/agents/${agent.agentId}/nodes/${node.nodeId}`;
      return allow ? put(path) : del(path);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: adminKeys.agents }),
  });

  return (
    <li data-node={node.nodeId} className="grid gap-2 px-5 py-4">
      <div className="flex items-center gap-3">
        <StatusDot tone={node.online ? "success" : "neutral"} />
        <div className="min-w-0 flex-1">
          <p className="break-all font-medium">{node.name}</p>
          <p className="mt-1 text-xs text-muted">
            {node.online ? "在线" : "离线"}
            {node.system === null ? "" : ` · ${node.system.platform} · ${node.system.arch}`}
          </p>
        </div>
        {home ? (
          <Badge>主 node</Badge>
        ) : (
          <Button size="sm" disabled={change.isPending} onClick={() => change.mutate(!granted)}>
            {change.isPending ? "更新中…" : granted ? "收回授权" : "授权访问"}
          </Button>
        )}
      </div>
      {home ? (
        <p className="text-xs text-muted">工作区和 MEMORY.md 在这里，始终可以访问。</p>
      ) : null}
      {change.isSuccess ? (
        <p role="status" className={cx("text-xs text-success", feedbackClass)}>
          {change.variables
            ? "已授权，从下一次调用起可以访问。"
            : "已收回授权，已启动的命令继续运行。"}
        </p>
      ) : null}
      <ErrorLine error={change.error} />
    </li>
  );
}

export function NodeAccess({ agent }: { agent: ReadableAgent }) {
  const nodes = useNodes(true);
  return (
    <Card role="region" aria-label="Node 访问">
      <CardBody>
        <div className="grid gap-1.5">
          <h2 className="font-medium">Node 访问</h2>
          <p className="text-sm text-muted">
            授权后，Agent 可以在其他 node
            账号的主目录里执行命令、读写文件。授权和收回只影响之后开始的调用。
          </p>
        </div>
        <ErrorLine error={nodes.error} />
      </CardBody>
      {nodes.data === undefined ? null : (
        <ul className="divide-y divide-border border-t border-border">
          {nodes.data.map((node) => (
            <NodeAccessRow key={node.nodeId} agent={agent} node={node} />
          ))}
        </ul>
      )}
    </Card>
  );
}
