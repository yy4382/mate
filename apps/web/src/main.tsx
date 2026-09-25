import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type ServiceState = "loading" | "running" | "unavailable";

function isRunningStatus(value: unknown): value is { status: "running" } {
  return (
    typeof value === "object" && value !== null && "status" in value && value.status === "running"
  );
}

function StatusPage() {
  const [state, setState] = useState<ServiceState>("loading");

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/status", { signal: controller.signal, headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error("Status request failed");
        const body: unknown = await response.json();
        if (!isRunningStatus(body)) throw new Error("Unexpected status response");
        setState("running");
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("unavailable");
      });
    return () => controller.abort();
  }, []);

  const statusText = {
    loading: "正在读取服务状态…",
    running: "服务正在运行",
    unavailable: "暂时无法连接控制面",
  }[state];

  return (
    <main className="page-shell">
      <section className="status-card" aria-labelledby="page-title">
        <p className="eyebrow">MATE 控制面</p>
        <h1 id="page-title">服务状态</h1>
        <div className={`status-line status-${state}`} role="status" aria-live="polite">
          <span className="status-mark" aria-hidden="true" />
          <span>{statusText}</span>
        </div>
        <p className="hint">此页面只显示控制面服务状态。</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StatusPage />);
