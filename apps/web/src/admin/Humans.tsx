import { AccountAvatar } from "../shell/AccountAvatar.tsx";
import { AvatarEditor } from "../shell/AvatarEditor.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { CircleUser, ImagePlus, KeyRound, Plus, ShieldCheck, ShieldOff, UserX } from "lucide-react";
import { useState } from "react";
import { ApiError, post } from "../shell/api.ts";
import { navigate } from "../shell/router.tsx";
import {
  HANDLE_PATTERN,
  ROLE_LABEL,
  currentHumanKey,
  refusalText,
  tooShort,
  useCurrentHuman,
  type ListedHuman,
  type Role,
} from "../shell/humans.ts";
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  ErrorLine,
  Field,
  Input,
  Menu,
  MenuItem,
  PageHeader,
  Select,
} from "../shell/ui.tsx";
import { adminKeys, useHumans } from "./data.ts";

/** The add form. The `requestId` stays the same across a retry that may have gone through, and is renewed once a refusal says nothing happened. */
function AddHuman({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [handleError, setHandleError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title="添加人类"
      description="给他一个 handle 和初始密码，他用这个登录，之后可以自己改。"
      onClose={onClose}
    >
      <form
        className="grid gap-4"
        aria-label="添加人类"
        onSubmit={async (event) => {
          event.preventDefault();
          setHandleError(null);
          setPasswordError(null);
          setError(null);
          if (tooShort(password)) return setPasswordError("初始密码至少 12 个字节。");
          try {
            await post("/api/humans", {
              requestId,
              handle: handle.trim(),
              displayName: displayName.trim(),
              password,
              role,
            });
            await qc.invalidateQueries({ queryKey: adminKeys.humans });
            onClose();
          } catch (cause) {
            if (cause instanceof ApiError && cause.status < 500) setRequestId(crypto.randomUUID());
            if (cause instanceof ApiError && cause.reason === "handle-taken")
              setHandleError(refusalText(cause));
            else setError(refusalText(cause));
          }
        }}
      >
        <Field label="显示名">
          <Input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
          />
        </Field>
        <Field label="Handle" error={handleError ?? undefined}>
          <Input
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            autoCapitalize="none"
            spellCheck={false}
            pattern={HANDLE_PATTERN}
            required
          />
        </Field>
        <Field label="初始密码" hint="至少 12 个字节。" error={passwordError ?? undefined}>
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        <Field label="角色">
          <Select value={role} onChange={(event) => setRole(event.target.value as Role)}>
            <option value="member">{ROLE_LABEL.member}</option>
            <option value="admin">{ROLE_LABEL.admin}</option>
          </Select>
        </Field>
        <ErrorLine error={error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary">
            添加
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ResetPassword({ human, onClose }: { human: ListedHuman; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title={`重置 ${human.displayName} 的密码`}
      description="他所有的登录会话会退出，需要用新密码重新登录。"
      onClose={onClose}
    >
      <form
        className="grid gap-4"
        aria-label="重置密码"
        onSubmit={async (event) => {
          event.preventDefault();
          setPasswordError(null);
          setError(null);
          if (tooShort(password)) return setPasswordError("新密码至少 12 个字节。");
          try {
            await post(`/api/humans/${human.accountId}/password`, { password });
            onClose();
          } catch (cause) {
            setError(refusalText(cause));
          }
        }}
      >
        <Field label="新密码" hint="至少 12 个字节。" error={passwordError ?? undefined}>
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        <ErrorLine error={error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary">
            重置密码
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function HumanRow({
  human,
  isMe,
  onError,
}: {
  human: ListedHuman;
  isMe: boolean;
  onError: (error: string | null) => void;
}) {
  const qc = useQueryClient();
  const [resetting, setResetting] = useState(false);
  const [editingAvatar, setEditingAvatar] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      onError(null);
      await qc.invalidateQueries({ queryKey: adminKeys.humans });
      await qc.invalidateQueries({ queryKey: currentHumanKey });
    } catch (cause) {
      onError(refusalText(cause));
    }
  };
  const other: Role = human.role === "admin" ? "member" : "admin";
  return (
    <li className="flex items-center gap-3 p-4" data-human={human.handle}>
      <AccountAvatar accountId={human.accountId} name={human.displayName} size="md" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate text-sm font-medium">{human.displayName}</span>
        <span className="text-sm text-muted">@{human.handle}</span>
        {isMe ? <Badge tone="accent">你</Badge> : null}
        {human.active ? (
          <Badge tone={human.role === "admin" ? "accent" : "neutral"}>
            {ROLE_LABEL[human.role]}
          </Badge>
        ) : (
          <Badge tone="danger">已停用</Badge>
        )}
      </div>
      {human.active ? (
        <Menu label={`更多：${human.displayName}`}>
          {isMe ? (
            <MenuItem icon={<CircleUser aria-hidden />} onClick={() => navigate("/app/profile")}>
              编辑个人资料
            </MenuItem>
          ) : null}
          <MenuItem icon={<ImagePlus aria-hidden />} onClick={() => setEditingAvatar(true)}>
            更换头像
          </MenuItem>
          <MenuItem
            icon={other === "admin" ? <ShieldCheck aria-hidden /> : <ShieldOff aria-hidden />}
            onClick={() => run(() => post(`/api/humans/${human.accountId}/role`, { role: other }))}
          >
            设为{ROLE_LABEL[other]}
          </MenuItem>
          {isMe ? null : (
            <>
              <MenuItem icon={<KeyRound aria-hidden />} onClick={() => setResetting(true)}>
                重置密码
              </MenuItem>
              <MenuItem
                tone="danger"
                icon={<UserX aria-hidden />}
                onClick={() => setConfirming(true)}
              >
                停用
              </MenuItem>
            </>
          )}
        </Menu>
      ) : null}
      {resetting ? <ResetPassword human={human} onClose={() => setResetting(false)} /> : null}
      {editingAvatar ? (
        <Dialog title={`更换 ${human.displayName} 的头像`} onClose={() => setEditingAvatar(false)}>
          <AvatarEditor
            accountId={human.accountId}
            name={human.displayName}
            endpoint={`/api/accounts/${human.accountId}/avatar`}
          />
        </Dialog>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`停用 ${human.displayName}？`}
        description="他会立即退出所有登录，也不能再登录，无法恢复。他发过的消息会保留。"
        confirmLabel="停用"
        onConfirm={() => run(() => post(`/api/humans/${human.accountId}/deactivate`))}
      />
    </li>
  );
}

export function Humans() {
  const humans = useHumans();
  const me = useCurrentHuman().data;
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <PageHeader
        title="人类"
        description="能登录 Mate 的人。管理员还能管理 Agent、提供商、node 和其他人类，普通人类只聊天。"
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            添加人类
          </Button>
        }
      />
      <ErrorLine error={humans.error ?? error} />
      {humans.data === undefined ? null : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {humans.data.map((human) => (
            <HumanRow
              key={human.accountId}
              human={human}
              isMe={human.accountId === me?.accountId}
              onError={setError}
            />
          ))}
        </ul>
      )}
      {adding ? <AddHuman onClose={() => setAdding(false)} /> : null}
    </>
  );
}
