import { useEffect, useState } from "react";

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
  pausedReason: "manual" | "credentials" | null;
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
      if (!response.ok) throw new Error();
      setPage((current) =>
        current ? { ...current, pausedReason: action === "pause" ? "manual" : null } : current,
      );
      setError(null);
    } catch {
      setError("无法改变 Agent 暂停状态，请稍后重试。");
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
              <span>{page.pausedReason === "manual" ? "人工暂停" : "模型凭据或配置待处理"}</span>
            )}
            <button
              type="button"
              onClick={() => void changePause(page?.pausedReason ? "resume" : "pause")}
            >
              {page?.pausedReason ? "恢复运行" : "暂停运行"}
            </button>
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
