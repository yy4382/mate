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
    <Dialog title="邀请加入频道" onClose={onClose}>
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
        <Field label="邀请谁">
          <Select value={invitee} onChange={(event) => setInvitee(event.target.value)} required>
            <option value="">选择…</option>
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
            邀请
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const kindLabel: Record<ConversationView["kind"], string> = {
  dm: "私信",
  private: "私有频道",
  public: "公开频道",
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
          aria-label="返回会话列表"
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
            {conversation.members.length} 位成员
            {conversation.archived ? " · 已归档" : ""}
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
                  邀请
                </Button>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label="邀请"
                  className="md:hidden"
                  onClick={() => setInviting(true)}
                >
                  <UserPlus aria-hidden />
                </Button>
              </>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => void act("join")}>
                加入
              </Button>
            )}
            <Menu label="更多">
              {conversation.member ? (
                <MenuItem icon={<LogOut aria-hidden />} onClick={() => setConfirming("leave")}>
                  离开频道
                </MenuItem>
              ) : null}
              <MenuItem
                icon={<Archive aria-hidden />}
                tone="danger"
                onClick={() => setConfirming("archive")}
              >
                归档频道
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
        title={`离开 ${label}？`}
        description="离开后不再收到这个频道的消息，也不能在其中发言。之后可以重新加入。"
        confirmLabel="离开"
        onConfirm={() => void act("leave")}
      />
      <ConfirmDialog
        open={confirming === "archive"}
        onOpenChange={(open) => setConfirming(open ? "archive" : null)}
        title={`归档 ${label}？`}
        description="归档后这个频道只能阅读，所有成员都不能再发言，也无法恢复。"
        confirmLabel="归档"
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
          找不到这个会话。
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
    ? "这个频道已归档，只能阅读。"
    : "你还没有加入这个频道，加入后才能发言。";
  const readonlyAction =
    conversation.member || conversation.archived ? undefined : (
      <Button variant="primary" size="sm" onClick={() => void act("join")}>
        加入频道
      </Button>
    );
  const label = conversationLabel(conversation, accounts, me);
  const placeholder = conversation.kind === "dm" ? `发消息给 ${label}` : `发消息到 #${label}`;
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
          aria-label="讨论串"
          className="absolute inset-0 z-10 flex flex-col bg-background md:static md:inset-auto md:w-[400px] md:shrink-0 md:border-l md:border-border"
        >
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4 md:justify-between">
            <Link
              to={chatPath(props.id)}
              className={buttonClass({
                variant: "ghost",
                size: "icon-sm",
                className: "-ml-2 md:order-last md:ml-0",
              })}
              aria-label="关闭讨论串"
            >
              <ChevronLeft aria-hidden className="md:hidden" />
              <X aria-hidden className="max-md:hidden" />
            </Link>
            <h2 className="text-base font-semibold">讨论串</h2>
          </header>
          <Timeline
            timelineRef={{ thread: props.thread }}
            conversation={props.id}
            seq={props.seq}
            canWrite={canWrite}
            readonlyReason={readonlyReason}
            readonlyAction={readonlyAction}
            placeholder="回复讨论串"
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
        找不到 @{handle}。
      </p>
    );
  return failed === null ? (
    <p className="p-6 text-sm text-muted">正在打开私信…</p>
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
          <EmptyState icon={<MessagesSquare />} title="选择一个会话">
            从左边选一个频道或私信，或者新建一个。
          </EmptyState>
        </div>
      ) : (
        <ConversationPanel id={route.conversation} thread={route.thread} seq={route.seq} />
      )}
    </main>
  );
}
