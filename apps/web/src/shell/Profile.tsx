import { useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { useState } from "react";
import { ApiError, patch, post } from "./api.ts";
import { unsubscribeThisBrowser } from "./Push.tsx";
import {
  HANDLE_PATTERN,
  ROLE_LABEL,
  currentHumanKey,
  refusalText,
  tooShort,
  useCurrentHuman,
  type HumanView,
} from "./humans.ts";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  Field,
  Input,
  PageHeader,
} from "./ui.tsx";

/** The saved note or error that sits in a form card's footer, next to its button. */
function Outcome({ saved, error }: { saved: boolean; error: string | null }) {
  if (error !== null)
    return (
      <p role="alert" className="text-sm text-danger">
        {error}
      </p>
    );
  return saved ? (
    <p role="status" className="text-sm text-muted">
      已保存
    </p>
  ) : (
    <span />
  );
}

function Names({ me }: { me: HumanView }) {
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState(me.displayName);
  const [handle, setHandle] = useState(me.handle);
  const [handleError, setHandleError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <Card>
      <form
        aria-label="基本信息"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaved(false);
          setHandleError(null);
          setError(null);
          try {
            const next = await patch<HumanView>("/api/me", {
              displayName: displayName.trim(),
              handle: handle.trim(),
            });
            qc.setQueryData(currentHumanKey, next);
            setDisplayName(next.displayName);
            setHandle(next.handle);
            setSaved(true);
          } catch (cause) {
            if (cause instanceof ApiError && cause.reason === "handle-taken")
              setHandleError(refusalText(cause));
            else setError(refusalText(cause));
          }
        }}
      >
        <CardBody>
          <Field label="显示名">
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </Field>
          <Field
            label="Handle"
            hint="登录用，也是别人 @ 你的名字。"
            error={handleError ?? undefined}
          >
            <Input
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              autoCapitalize="none"
              spellCheck={false}
              pattern={HANDLE_PATTERN}
              required
            />
          </Field>
        </CardBody>
        <CardFooter>
          <Outcome saved={saved} error={error} />
          <Button type="submit" variant="primary">
            保存
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [nextError, setNextError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <Card>
      <form
        aria-label="修改密码"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaved(false);
          setCurrentError(null);
          setNextError(null);
          setError(null);
          if (tooShort(next)) return setNextError("新密码至少 12 个字节。");
          if (next !== again) return setNextError("两次输入的新密码不一致。");
          try {
            await post("/api/me/password", { current, next });
            setCurrent("");
            setNext("");
            setAgain("");
            setSaved(true);
          } catch (cause) {
            if (cause instanceof ApiError && cause.reason === "wrong-password")
              setCurrentError(refusalText(cause));
            else setError(refusalText(cause));
          }
        }}
      >
        <CardBody>
          <Field label="当前密码" error={currentError ?? undefined}>
            <Input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              required
            />
          </Field>
          <Field
            label="新密码"
            hint="至少 12 个字节。改完后，你在其他浏览器上的登录会退出。"
            error={nextError ?? undefined}
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              required
            />
          </Field>
          <Field label="确认新密码">
            <Input
              type="password"
              autoComplete="new-password"
              value={again}
              onChange={(event) => setAgain(event.target.value)}
              required
            />
          </Field>
        </CardBody>
        <CardFooter>
          <Outcome saved={saved} error={error} />
          <Button type="submit" variant="primary">
            修改密码
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

/** Stops this browser's notifications first, so the next human to log in here does not get this one's. */
export async function logOut(): Promise<void> {
  try {
    await unsubscribeThisBrowser();
  } catch {
    // Logging out matters more than the notifications; the server drops the subscription when the next human takes it.
  }
  await post("/api/logout");
  location.assign("/login");
}

export function ProfilePage() {
  const me = useCurrentHuman().data;
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-6 md:px-8 md:py-8">
      <PageHeader
        title="个人资料"
        description="你在 Mate 里的名字和登录方式。"
        {...(me === undefined
          ? {}
          : {
              leading: <Avatar name={me.displayName} size="lg" />,
              badge: (
                <Badge tone={me.role === "admin" ? "accent" : "neutral"}>
                  {ROLE_LABEL[me.role]}
                </Badge>
              ),
            })}
      />
      {me === undefined ? null : (
        <>
          <section className="grid gap-4">
            <h2 className="text-base font-semibold">基本信息</h2>
            <Names me={me} />
          </section>
          <section className="grid gap-4">
            <h2 className="text-base font-semibold">密码</h2>
            <ChangePassword />
          </section>
          <section className="grid gap-4">
            <h2 className="text-base font-semibold">登录状态</h2>
            <div>
              <Button variant="secondary" onClick={() => void logOut()}>
                <LogOut aria-hidden />
                退出登录
              </Button>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
