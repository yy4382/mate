import { passwordTooShort } from "@mate/control-plane/passwords";
import { t } from "../i18n.ts";
import { useQueryClient } from "@tanstack/react-query";
import { CircleUser, KeyRound, Plus, ShieldCheck, ShieldOff, UserX } from "lucide-react";
import { useState } from "react";
import { ApiError, post } from "../shell/api.ts";
import { navigate } from "../shell/router.tsx";
import {
  HANDLE_PATTERN,
  ROLE_LABEL,
  currentHumanKey,
  refusalText,
  useCurrentHuman,
  type HumanView,
  type Role,
} from "../shell/humans.ts";
import {
  Avatar,
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
      title={t("Humans.addHuman")}
      description={t("Humans.giveThemAHandleAndInitialPasswordTo")}
      onClose={onClose}
    >
      <form
        className="grid gap-4"
        aria-label={t("Humans.addHuman")}
        onSubmit={async (event) => {
          event.preventDefault();
          setHandleError(null);
          setPasswordError(null);
          setError(null);
          if (passwordTooShort(password))
            return setPasswordError(t("Humans.theInitialPasswordMustBeAtLeast12"));
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
        <Field label={t("Humans.displayName")}>
          <Input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
          />
        </Field>
        <Field label={t("common.handle")} error={handleError ?? undefined}>
          <Input
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            autoCapitalize="none"
            spellCheck={false}
            pattern={HANDLE_PATTERN}
            required
          />
        </Field>
        <Field
          label={t("Humans.initialPassword")}
          hint={t("Humans.atLeast12Bytes")}
          error={passwordError ?? undefined}
        >
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        <Field label={t("Humans.role")}>
          <Select value={role} onChange={(event) => setRole(event.target.value as Role)}>
            <option value="member">{ROLE_LABEL.member}</option>
            <option value="admin">{ROLE_LABEL.admin}</option>
          </Select>
        </Field>
        <ErrorLine error={error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary">
            {t("Humans.add")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ResetPassword({ human, onClose }: { human: HumanView; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title={t("Humans.resetNamed", { name: human.displayName })}
      description={t("Humans.allTheirLoginSessionsWillEndTheyWill")}
      onClose={onClose}
    >
      <form
        className="grid gap-4"
        aria-label={t("Humans.resetPassword")}
        onSubmit={async (event) => {
          event.preventDefault();
          setPasswordError(null);
          setError(null);
          if (passwordTooShort(password))
            return setPasswordError(t("Humans.theNewPasswordMustBeAtLeast12"));
          try {
            await post(`/api/humans/${human.accountId}/password`, { password });
            onClose();
          } catch (cause) {
            setError(refusalText(cause));
          }
        }}
      >
        <Field
          label={t("Humans.newPassword")}
          hint={t("Humans.atLeast12Bytes")}
          error={passwordError ?? undefined}
        >
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
            {t("Humans.resetPassword")}
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
  human: HumanView;
  isMe: boolean;
  onError: (error: string | null) => void;
}) {
  const qc = useQueryClient();
  const [resetting, setResetting] = useState(false);
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
      <Avatar name={human.displayName} size="md" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate text-sm font-medium">{human.displayName}</span>
        <span className="text-sm text-muted">@{human.handle}</span>
        {isMe ? <Badge tone="accent">{t("Humans.you")}</Badge> : null}
        {human.active ? (
          <Badge tone={human.role === "admin" ? "accent" : "neutral"}>
            {ROLE_LABEL[human.role]}
          </Badge>
        ) : (
          <Badge tone="danger">{t("Humans.deactivated")}</Badge>
        )}
      </div>
      {human.active ? (
        <Menu label={t("common.moreFor", { name: human.displayName })}>
          {isMe ? (
            <MenuItem icon={<CircleUser aria-hidden />} onClick={() => navigate("/app/profile")}>
              {t("Humans.editProfile")}
            </MenuItem>
          ) : null}
          <MenuItem
            icon={other === "admin" ? <ShieldCheck aria-hidden /> : <ShieldOff aria-hidden />}
            onClick={() => run(() => post(`/api/humans/${human.accountId}/role`, { role: other }))}
          >
            {t("Humans.setRole", { role: ROLE_LABEL[other] })}
          </MenuItem>
          {isMe ? null : (
            <>
              <MenuItem icon={<KeyRound aria-hidden />} onClick={() => setResetting(true)}>
                {t("Humans.resetPassword")}
              </MenuItem>
              <MenuItem
                tone="danger"
                icon={<UserX aria-hidden />}
                onClick={() => setConfirming(true)}
              >
                {t("Humans.deactivate")}
              </MenuItem>
            </>
          )}
        </Menu>
      ) : null}
      {resetting ? <ResetPassword human={human} onClose={() => setResetting(false)} /> : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("Humans.deactivateNamed", { name: human.displayName })}
        description={t("Humans.allTheirLoginSessionsWillEndImmediatelyAnd")}
        confirmLabel={t("Humans.deactivate")}
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
        title={t("Humans.humans")}
        description={t("Humans.peopleWhoCanSignInToMateAdministrators")}
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            {t("Humans.addHuman")}
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
