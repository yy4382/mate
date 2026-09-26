import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { ChatPage } from "./chat-app.js";
import { NodesPage } from "./nodes-page.js";
import { AgentsPage } from "./agents-page.js";
import { TasksPage } from "./tasks-page.js";
import { RemindersPage } from "./reminders-page.js";
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
        <p className="hint">此页面只显示控制面服务状态。</p>
        <a className="button-link status-login" href="/login">
          所有者登录
        </a>
      </section>
    </main>
  );
}

function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ password: form.get("password") }),
      });
      if (response.ok) {
        window.location.assign("/app");
        return;
      }
      const result: unknown = await response.json();
      setError(
        typeof result === "object" && result !== null && "error" in result
          ? String(result.error)
          : "登录失败，请重试。",
      );
    } catch {
      setError("暂时无法连接控制面，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="page-shell">
      <section className="auth-card" aria-labelledby="page-title">
        <p className="eyebrow">MATE 控制面</p>
        <h1 id="page-title">所有者登录</h1>
        <form className="auth-form" onSubmit={submit}>
          <label htmlFor="owner-password">密码</label>
          <input
            id="owner-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={submitting}>
            {submitting ? "正在登录…" : "登录"}
          </button>
        </form>
        <a className="subtle-link" href="/">
          返回服务状态
        </a>
      </section>
    </main>
  );
}

const path = window.location.pathname;
const Page =
  path === "/login" || path.startsWith("/login/")
    ? LoginPage
    : path.startsWith("/app/agents/") && path.endsWith("/reminders")
      ? RemindersPage
      : path === "/app/tasks" || path.startsWith("/app/tasks/")
        ? TasksPage
        : path === "/app/agents" || path.startsWith("/app/agents/")
          ? AgentsPage
          : path === "/app/nodes" || path.startsWith("/app/nodes/")
            ? NodesPage
            : path === "/app" || path.startsWith("/app/")
              ? ChatPage
              : StatusPage;

createRoot(document.getElementById("root")!).render(<Page />);
