import type { LoginInput, LoginResult } from "@mate/auth";
import { t } from "../i18n.ts";
import { useState } from "react";
import { Mark } from "./App.tsx";
import { ApiError, post } from "./api.ts";
import { Button, Card, CardBody, ErrorLine, Field, Input } from "./ui.tsx";

export function Login({ next }: { next: string | null }) {
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-sm duration-[250ms]">
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              const result = await post<LoginResult>("/api/login", {
                handle: handle.trim(),
                password,
                ...(next === null ? {} : { next }),
              } satisfies LoginInput);
              location.assign(result.next);
            } catch (error) {
              setBusy(false);
              setMessage(
                error instanceof ApiError && error.status === 401
                  ? t("Login.incorrectHandleOrPassword")
                  : error instanceof ApiError && error.status === 429
                    ? t("Login.tooManySigninAttemptsTryAgainLater")
                    : t("Login.signinFailedPleaseTryAgain"),
              );
            }
          }}
        >
          <CardBody className="gap-6 p-6">
            <div className="grid justify-items-start gap-4">
              <Mark className="size-10 rounded-lg text-base" />
              <h1 className="text-2xl font-semibold tracking-tight">{t("Login.signInToMate")}</h1>
            </div>
            <Field label={t("common.handle")}>
              <Input
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={handle}
                onChange={(event) => setHandle(event.target.value)}
                autoFocus
                required
              />
            </Field>
            <Field label={t("Login.password")}>
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </Field>
            <ErrorLine error={message} />
            <Button type="submit" variant="primary" disabled={busy}>
              {t("Login.signIn")}
            </Button>
          </CardBody>
        </form>
      </Card>
    </main>
  );
}
