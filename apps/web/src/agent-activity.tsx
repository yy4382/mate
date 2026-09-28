import { useEffect, useState } from "react";
import { agentStopStatus, type AgentStop } from "./agent-stop-status.js";

interface ActivityEvent {
  sequence: number;
  kind: string;
  referenceId: string | null;
  summary: string;
  detail?: unknown;
  at: number;
}

interface ActivityPage {
  events: ActivityEvent[];
  nodeOnline: boolean;
  pausedReason: "manual" | "credentials" | "context" | null;
  stop: AgentStop | null;
  nextBefore: number | null;
}

export function AgentActivity({ agentId }: { agentId: string }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<ActivityPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function changePause(action: "pause" | "resume") {
    try {
      const response = await fetch(`/api/owner/agents/${encodeURIComponent(agentId)}/${action}`, {
        method: "POST",
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(result?.error ?? "无法改变 Agent 状态。");
      }
      const result = (await response.json()) as { stop?: AgentStop };
      setPage((current) =>
        current
          ? {
              ...current,
              pausedReason: action === "pause" ? "manual" : null,
              stop:
                action === "pause" ? (result.stop ?? { state: "unknown", receipt: null }) : null,
            }
          : current,
      );
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法改变 Agent 状态，请稍后重试。");
    }
  }
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(
          `/api/owner/agents/${encodeURIComponent(agentId)}/activity${expanded ? "?detail=1" : ""}`,
          { signal: controller.signal, headers: { Accept: "application/json" } },
        );
        if (!response.ok) throw new Error("无法读取 Agent 动态。");
        setPage((await response.json()) as ActivityPage);
        setError(null);
      } catch {
        if (!controller.signal.aborted) setError("无法读取 Agent 动态，请稍后重试。");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [agentId, open, expanded]);
  const stopStatus = agentStopStatus(page?.stop);
  return (
    <section className="agent-activity" aria-label="Agent 动态">
      <button type="button" onClick={() => setOpen(!open)}>
        {open ? "收起动态" : "查看动态"}
      </button>
      {open && (
        <>
          <div className="agent-activity-toolbar">
            <span>{page?.nodeOnline ? "节点在线" : "节点离线 · 以下为最后已确认事实"}</span>
            {page?.pausedReason && (
              <span>
                {page.pausedReason === "manual"
                  ? "已停用"
                  : page.pausedReason === "context"
                    ? "上下文压缩待处理"
                    : "模型凭据或配置待处理"}
              </span>
            )}
            {page?.pausedReason === "manual" && <span role="status">{stopStatus.summary}</span>}
            <button
              type="button"
              onClick={() =>
                void changePause(
                  page?.pausedReason === "manual" || page?.pausedReason === "context"
                    ? "resume"
                    : "pause",
                )
              }
            >
              {page?.pausedReason === "manual"
                ? "复启 Agent"
                : page?.pausedReason === "context"
                  ? "重试 Agent"
                  : "停用 Agent"}
            </button>
            {page?.pausedReason === "manual" &&
              (page.stop?.state === "unknown" || page.stop?.state === "failed") && (
                <button
                  type="button"
                  disabled={stopStatus.awaitingProcessReceipts}
                  onClick={() => void changePause("pause")}
                >
                  {stopStatus.awaitingProcessReceipts ? "等待操作收据对账" : stopStatus.retryLabel}
                </button>
              )}
            <button type="button" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? "隐藏详情" : "展开详情"}
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
          <ol className="agent-activity-list">
            {page?.events.map((event) => (
              <li key={event.sequence}>
                <time dateTime={new Date(event.at).toISOString()}>
                  {new Date(event.at).toLocaleString("zh-CN")}
                </time>
                <span>{event.summary}</span>
                {expanded && event.detail !== undefined && (
                  <pre>{JSON.stringify(event.detail, null, 2)}</pre>
                )}
              </li>
            ))}
          </ol>
          {page?.events.length === 0 && <p>暂无运行动态。</p>}
        </>
      )}
    </section>
  );
}
