import { useEffect, useState } from "react";
import "./approval-card.css";

export interface Approval {
  requestId: string;
  operationId: string;
  agentId: string;
  nodeId: string;
  channelId: string;
  program: string;
  args: string[];
  cwd: string;
  expiresAt: number;
  createdAt: number;
  state:
    | "pending"
    | "approved"
    | "running"
    | "succeeded"
    | "failed"
    | "unknown"
    | "rejected"
    | "expired";
  receipt: unknown | null;
  nodeOnline: boolean;
  nodeLastConnectedAt: string | null;
}

const labels: Record<Approval["state"], string> = {
  pending: "等待你的审批",
  approved: "已批准，等待执行",
  running: "执行中",
  succeeded: "执行成功",
  failed: "执行失败",
  unknown: "执行结果未知",
  rejected: "已拒绝，未执行",
  expired: "已过期，未执行",
};

export function ApprovalCard({
  approval,
  agentName,
  onDecision,
}: {
  approval: Approval;
  agentName: string;
  onDecision(requestId: string, decision: "approve" | "reject"): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = Math.max(0, Math.ceil((approval.expiresAt - now) / 1000));
  const pending = approval.state === "pending" && remaining > 0;
  const state = approval.state === "pending" && !remaining ? "expired" : approval.state;
  const stateLabel =
    state === "approved" && !approval.nodeOnline ? "已批准，等待节点" : labels[state];
  return (
    <article className="approval-card" aria-label={`系统特权审批 ${approval.requestId}`}>
      <div className="approval-heading">
        <strong>系统特权命令</strong>
        <span>{stateLabel}</span>
      </div>
      <dl>
        <div>
          <dt>请求 ID</dt>
          <dd>{approval.requestId}</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>
            {agentName} · {approval.agentId}
          </dd>
        </div>
        <div>
          <dt>节点</dt>
          <dd>{approval.nodeId}</dd>
        </div>
        <div>
          <dt>节点连接</dt>
          <dd>
            {approval.nodeOnline
              ? "节点在线"
              : approval.nodeLastConnectedAt
                ? `节点离线，上次连接：${new Date(approval.nodeLastConnectedAt).toLocaleString("zh-CN")}`
                : "节点离线，尚无连接记录"}
          </dd>
        </div>
        <div>
          <dt>程序摘要</dt>
          <dd>{approval.program.split("/").at(-1)}</dd>
        </div>
        <div>
          <dt>工作目录</dt>
          <dd>
            <code>{approval.cwd}</code>
          </dd>
        </div>
        <div>
          <dt>到期</dt>
          <dd>
            <time dateTime={new Date(approval.expiresAt).toISOString()}>
              {new Date(approval.expiresAt).toLocaleString("zh-CN")}
            </time>
          </dd>
        </div>
        <div>
          <dt>剩余时间</dt>
          <dd>{remaining} 秒</dd>
        </div>
      </dl>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? "收起完整命令" : "展开完整命令"}
      </button>
      {expanded && (
        <div className="approval-full-command">
          <p>
            程序路径：<code>{approval.program}</code>
          </p>
          <ol aria-label="命令参数">
            {approval.args.map((arg, index) => (
              <li key={index}>
                <span>参数 {index + 1}</span>
                <code>{arg}</code>
              </li>
            ))}
          </ol>
          {approval.args.length === 0 && <p>无参数</p>}
          <p className="approval-warning">
            脚本、软件包、插件及依赖可能在审批后发生变化；批准不会冻结其内容。
          </p>
          {pending && (
            <div className="approval-actions">
              <button type="button" onClick={() => onDecision(approval.requestId, "approve")}>
                批准执行
              </button>
              <button type="button" onClick={() => onDecision(approval.requestId, "reject")}>
                拒绝
              </button>
            </div>
          )}
          {approval.receipt !== null && (
            <pre aria-label="执行收据">{JSON.stringify(approval.receipt, null, 2)}</pre>
          )}
        </div>
      )}
    </article>
  );
}
