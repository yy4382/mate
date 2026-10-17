import { useState } from "react";
import { ApiError, post } from "./api.ts";

export function Login({ next }: { next: string | null }) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <form
        className="card form"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            const result = await post<{ next: string }>("/api/login", {
              password,
              ...(next === null ? {} : { next }),
            });
            location.assign(result.next);
          } catch (error) {
            setBusy(false);
            setMessage(
              error instanceof ApiError && error.status === 401
                ? "密码不对。"
                : error instanceof ApiError && error.status === 429
                  ? "尝试的人太多了，请稍后再试。"
                  : "登录失败，请重试。",
            );
          }
        }}
      >
        <p className="eyebrow">MATE</p>
        <h1>登录</h1>
        <label>
          密码
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
            required
          />
        </label>
        {message === null ? null : (
          <p className="error" role="alert">
            {message}
          </p>
        )}
        <button className="button primary" type="submit" disabled={busy}>
          登录
        </button>
      </form>
    </main>
  );
}
