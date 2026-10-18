import { useState } from "react";
import { Mark } from "./App.tsx";
import { ApiError, post } from "./api.ts";
import { Button, Card, CardBody, ErrorLine, Field, Input } from "./ui.tsx";

export function Login({ next }: { next: string | null }) {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-sm">
        <form
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
          <CardBody className="gap-6 p-8">
            <div className="grid justify-items-start gap-4">
              <Mark className="size-10 rounded-lg text-base" />
              <h1 className="text-2xl font-semibold tracking-tight">登录 Mate</h1>
            </div>
            <Field label="密码">
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoFocus
                required
              />
            </Field>
            <ErrorLine error={message} />
            <Button type="submit" variant="primary" disabled={busy}>
              登录
            </Button>
          </CardBody>
        </form>
      </Card>
    </main>
  );
}
