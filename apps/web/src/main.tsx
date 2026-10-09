import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { ChatPage } from "./features/conversations/chat-page.js";
import { NodesPage } from "./features/nodes/nodes-page.js";
import { AgentsPage } from "./features/agents/agents-page.js";
import { TasksPage } from "./features/tasks/tasks-page.js";
import { RemindersPage } from "./features/reminders/reminders-page.js";
import { watchServiceStatus, type ServiceState } from "./status-monitor.js";
import { appReturnPath } from "./navigation.js";
import { jsonRequest, responseErrorMessage } from "./http-json.js";
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
      const response = await fetch(
        "/api/auth/login",
        jsonRequest("POST", { password: form.get("password") }),
      );
      if (response.ok) {
        window.location.assign(appReturnPath(window.location.search));
        return;
      }
      const result: unknown = await response.json();
      setError(responseErrorMessage(result, "登录失败，请重试。"));
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

function pageForPath(path: string) {
  if (path === "/login" || path.startsWith("/login/")) return LoginPage;
  if (path.startsWith("/app/agents/") && path.endsWith("/reminders")) return RemindersPage;
  if (path === "/app/tasks" || path.startsWith("/app/tasks/")) return TasksPage;
  if (path === "/app/agents" || path.startsWith("/app/agents/")) return AgentsPage;
  if (path === "/app/nodes" || path.startsWith("/app/nodes/")) return NodesPage;
  if (path === "/app" || path.startsWith("/app/")) return ChatPage;
  return StatusPage;
}

const Page = pageForPath(window.location.pathname);

createRoot(document.getElementById("root")!).render(<Page />);
