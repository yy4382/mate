import { t } from "../i18n.ts";
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
            {node.online ? t("NodeAccess.online") : t("NodeAccess.offline")}
            {node.system === null ? "" : ` · ${node.system.platform} · ${node.system.arch}`}
          </p>
        </div>
        {home ? (
          <Badge>{t("NodeAccess.homeNode")}</Badge>
        ) : (
          <Button size="sm" disabled={change.isPending} onClick={() => change.mutate(!granted)}>
            {change.isPending
              ? t("NodeAccess.updating")
              : granted
                ? t("NodeAccess.revokeAccess")
                : t("NodeAccess.grantAccess")}
          </Button>
        )}
      </div>
      {home ? (
        <p className="text-xs text-muted">
          {t("NodeAccess.theWorkspaceAndMemorymdAreHereAccessIs")}
        </p>
      ) : null}
      {change.isSuccess ? (
        <p role="status" className={cx("text-xs text-success", feedbackClass)}>
          {change.variables
            ? t("NodeAccess.accessGrantedForSubsequentCalls")
            : t("NodeAccess.accessRevokedCommandsAlreadyStartedWillContinueRunning")}
        </p>
      ) : null}
      <ErrorLine error={change.error} />
    </li>
  );
}

export function NodeAccess({ agent }: { agent: ReadableAgent }) {
  const nodes = useNodes(true);
  return (
    <Card role="region" aria-label={t("NodeAccess.nodeAccess")}>
      <CardBody>
        <div className="grid gap-1.5">
          <h2 className="font-medium">{t("NodeAccess.nodeAccess")}</h2>
          <p className="text-sm text-muted">
            {t("NodeAccess.onceGrantedAccessTheAgentCanRunCommands")}
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
