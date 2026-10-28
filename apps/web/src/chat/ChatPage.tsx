import { t } from "../i18n.ts";
import { useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ChevronLeft,
  Hash,
  Lock,
  LogOut,
  MessagesSquare,
  UserPlus,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { post } from "../shell/api.ts";
import { Link, chatPath, navigate, useRoute } from "../shell/router.tsx";
import {
  Avatar,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorLine,
  Field,
  Menu,
  MenuItem,
  Select,
  buttonClass,
} from "../shell/ui.tsx";
import { keys } from "./cache.ts";
import { avatarOf, conversationLabel, useAccounts, useConversations, useMe } from "./data.ts";
import { Timeline } from "./Timeline.tsx";
import type { ConversationView } from "./types.ts";

function Invite({
  conversation,
  onClose,
}: {
  conversation: ConversationView;
  onClose: () => void;
}) {
  const accounts = useAccounts().data ?? [];
  const [invitee, setInvitee] = useState("");
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog title={t("ChatPage.inviteToChannel")} onClose={onClose}>
      <form
        className="grid gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await post(`/api/chat/conversations/${conversation.conversationId}/invite`, {
              requestId: crypto.randomUUID(),
              invitee: Number(invitee),
            });
            onClose();
          } catch (cause) {
            setError(cause);
          }
        }}
      >
        <Field label={t("ChatPage.whoToInvite")}>
          <Select value={invitee} onChange={(event) => setInvitee(event.target.value)} required>
            <option value="">{t("ChatPage.select")}</option>
            {accounts
              .filter((a) => a.active && !conversation.members.includes(a.accountId))
              .map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.displayName}（@{a.handle}）
                </option>
              ))}
          </Select>
        </Field>
        <ErrorLine error={error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary">
            {t("ChatPage.invite")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const kindLabel: Record<ConversationView["kind"], string> = {
  dm: t("ChatPage.directMessages"),
  private: t("ChatPage.privateChannel"),
  public: t("ChatPage.publicChannel"),
};

type Action = "join" | "leave" | "archive";

function Header({
  conversation,
  act,
  error,
}: {
  conversation: ConversationView;
  act: (action: Action) => Promise<void>;
  error: unknown;
}) {
  const accounts = useAccounts().data ?? [];
  const [inviting, setInviting] = useState(false);
  const [confirming, setConfirming] = useState<"leave" | "archive" | null>(null);
  const channel = conversation.kind !== "dm";
  const me = useMe().data;
  const label = conversationLabel(conversation, accounts, me);
  const otherId = conversation.members.find((id) => id !== me);
  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 md:px-6">
        <Link
          to="/app"
          className={buttonClass({
            variant: "ghost",
            size: "icon-sm",
            className: "-ml-2 md:hidden",
          })}
          aria-label={t("ChatPage.backToConversations")}
        >
          <ChevronLeft aria-hidden />
        </Link>
        <span className="text-muted [&_svg]:size-5">
          {conversation.kind === "dm" ? (
            <Avatar size="sm" {...avatarOf(accounts, otherId ?? 0)} />
          ) : conversation.kind === "private" ? (
            <Lock aria-hidden />
          ) : (
            <Hash aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold leading-5">{label}</h1>
          <p className="truncate text-xs text-muted">
            {kindLabel[conversation.kind]}
            {" · "}
            {t("ChatPage.memberCount", { count: conversation.members.length })}
            {conversation.archived ? t("ChatPage.archivedSuffix") : ""}
          </p>
        </div>
        {channel && !conversation.archived ? (
          <div className="flex items-center gap-2">
            {conversation.member ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  className="max-md:hidden"
                  onClick={() => setInviting(true)}
                >
                  <UserPlus aria-hidden />
                  {t("ChatPage.invite")}
                </Button>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label={t("ChatPage.invite")}
                  className="md:hidden"
                  onClick={() => setInviting(true)}
                >
                  <UserPlus aria-hidden />
                </Button>
              </>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => void act("join")}>
                {t("ChatPage.join")}
              </Button>
            )}
            <Menu label={t("ChatPage.more")}>
              {conversation.member ? (
                <MenuItem icon={<LogOut aria-hidden />} onClick={() => setConfirming("leave")}>
                  {t("ChatPage.leaveChannel")}
                </MenuItem>
              ) : null}
              <MenuItem
                icon={<Archive aria-hidden />}
                tone="danger"
                onClick={() => setConfirming("archive")}
              >
                {t("ChatPage.archiveChannel")}
              </MenuItem>
            </Menu>
          </div>
        ) : null}
      </header>
      {error === null ? null : (
        <div className="shrink-0 border-b border-border px-4 py-2 md:px-6">
          <ErrorLine error={error} />
        </div>
      )}
      {inviting ? <Invite conversation={conversation} onClose={() => setInviting(false)} /> : null}
      <ConfirmDialog
        open={confirming === "leave"}
        onOpenChange={(open) => setConfirming(open ? "leave" : null)}
        title={t("ChatPage.leaveNamed", { name: label })}
        description={t("ChatPage.youWillStopReceivingMessagesFromThisChannel")}
        confirmLabel={t("ChatPage.leave")}
        onConfirm={() => void act("leave")}
      />
      <ConfirmDialog
        open={confirming === "archive"}
        onOpenChange={(open) => setConfirming(open ? "archive" : null)}
        title={t("ChatPage.archiveNamed", { name: label })}
        description={t("ChatPage.thisChannelWillBecomePermanentlyReadonlyForAll")}
        confirmLabel={t("ChatPage.archive")}
        onConfirm={() => void act("archive")}
      />
    </>
  );
}

function ConversationPanel(props: { id: number; thread: number | null; seq: number | null }) {
  const conversations = useConversations();
  const accounts = useAccounts().data ?? [];
  const me = useMe().data;
  const [error, setError] = useState<unknown>(null);
  const conversation = conversations.data?.find((c) => c.conversationId === props.id);
  if (conversation === undefined)
    return (
      <section className="grid h-full place-items-center p-6">
        <p className="text-sm text-muted" role="alert">
          {t("ChatPage.conversationNotFound")}
        </p>
      </section>
    );
  const act = async (action: Action) => {
    try {
      await post(`/api/chat/conversations/${conversation.conversationId}/${action}`, {
        requestId: crypto.randomUUID(),
      });
      setError(null);
    } catch (cause) {
      setError(cause);
    }
  };
  const canWrite = conversation.member && !conversation.archived;
  const readonlyReason = conversation.archived
    ? t("ChatPage.thisChannelIsArchivedAndReadonly")
    : t("ChatPage.joinThisChannelToPostMessages");
  const readonlyAction =
    conversation.member || conversation.archived ? undefined : (
      <Button variant="primary" size="sm" onClick={() => void act("join")}>
        {t("ChatPage.joinChannel")}
      </Button>
    );
  const label = conversationLabel(conversation, accounts, me);
  const placeholder =
    conversation.kind === "dm"
      ? t("ChatPage.messagePerson", { name: label })
      : t("ChatPage.messageChannel", { name: label });
  return (
    <div className="relative flex h-full min-h-0">
      <section className="flex min-w-0 flex-1 flex-col">
        <Header conversation={conversation} act={act} error={error} />
        <Timeline
          timelineRef={{ conversation: props.id }}
          conversation={props.id}
          seq={props.thread === null ? props.seq : null}
          canWrite={canWrite}
          readonlyReason={readonlyReason}
          readonlyAction={readonlyAction}
          placeholder={placeholder}
        />
      </section>
      {props.thread === null ? null : (
        <aside
          aria-label={t("ChatPage.thread")}
          className="absolute inset-0 z-10 flex flex-col bg-background transition-[opacity,translate] duration-[240ms] ease-out-expo starting:opacity-0 motion-safe:starting:translate-x-10 motion-safe:md:starting:translate-x-6 motion-reduce:transition-opacity motion-reduce:duration-[120ms] md:static md:inset-auto md:w-[400px] md:shrink-0 md:duration-[220ms] md:border-l md:border-border [html[data-input=keyboard]_&]:transition-none"
        >
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4 md:justify-between">
            <Link
              to={chatPath(props.id)}
              className={buttonClass({
                variant: "ghost",
                size: "icon-sm",
                className: "-ml-2 md:order-last md:ml-0",
              })}
              aria-label={t("ChatPage.closeThread")}
            >
              <ChevronLeft aria-hidden className="md:hidden" />
              <X aria-hidden className="max-md:hidden" />
            </Link>
            <h2 className="text-base font-semibold">{t("ChatPage.thread")}</h2>
          </header>
          <Timeline
            timelineRef={{ thread: props.thread }}
            conversation={props.id}
            seq={props.seq}
            canWrite={canWrite}
            readonlyReason={readonlyReason}
            readonlyAction={readonlyAction}
            placeholder={t("ChatPage.replyToThread")}
          />
        </aside>
      )}
    </div>
  );
}

/** `/app?dm=<handle>`: open the direct message with that account, whoever links here (the Agent list does). */
function OpenDirectMessage({ handle }: { handle: string }) {
  const qc = useQueryClient();
  const accounts = useAccounts().data ?? [];
  const [failed, setFailed] = useState<unknown>(null);
  const account = accounts.find((a) => a.handle.toLowerCase() === handle.toLowerCase());
  useEffect(() => {
    if (account === undefined) return;
    post<ConversationView>("/api/chat/dms", {
      requestId: crypto.randomUUID(),
      other: account.accountId,
    }).then((conversation) => {
      qc.setQueryData<ConversationView[]>(keys.conversations, (old = []) =>
        old.some((c) => c.conversationId === conversation.conversationId)
          ? old
          : [...old, conversation],
      );
      navigate(chatPath(conversation.conversationId), { replace: true });
    }, setFailed);
  }, [account, qc]);
  if (account === undefined)
    return (
      <p className="p-6 text-sm text-danger" role="alert">
        {t("ChatPage.accountNotFound", { handle })}
      </p>
    );
  return failed === null ? (
    <p className="p-6 text-sm text-muted">{t("ChatPage.openingDirectMessage")}</p>
  ) : (
    <div className="p-6">
      <ErrorLine error={failed} />
    </div>
  );
}

export function ChatPage() {
  const route = useRoute();
  if (route.page !== "chat") return null;
  return (
    <main className="h-full">
      {route.dm !== null ? (
        <OpenDirectMessage handle={route.dm} />
      ) : route.conversation === null ? (
        <div className="grid h-full place-items-center p-6">
          <EmptyState icon={<MessagesSquare />} title={t("ChatPage.chooseAConversation")}>
            {t("ChatPage.chooseAChannelOrDirectMessageFromThe")}
          </EmptyState>
        </div>
      ) : (
        <ConversationPanel id={route.conversation} thread={route.thread} seq={route.seq} />
      )}
    </main>
  );
}
