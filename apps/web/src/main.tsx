import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { watchServiceStatus, type ServiceState } from "./status-monitor.js";
import "./style.css";

function StatusPage() {
  const [state, setState] = useState<ServiceState>("loading");

  useEffect(() => {
    return watchServiceStatus(setState);
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
        <p className="hint">状态定期更新；此页面只显示控制面服务状态。</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StatusPage />);
