import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { post } from "../shell/api.ts";
import { Link, chatPath, navigate, useRoute } from "../shell/router.tsx";
import { ConfirmButton, Dialog, ErrorLine } from "../shell/ui.tsx";
import { keys } from "./cache.ts";
import { conversationLabel, ownerOf, useAccounts, useConversations, useUnread } from "./data.ts";
import { Timeline } from "./Timeline.tsx";
import type { ConversationView } from "./types.ts";

function ConversationList({ activeId }: { activeId: number | null }) {
  const accounts = useAccounts().data ?? [];
  const conversations = useConversations().data ?? [];
  const unread = useUnread().data;
  const [creating, setCreating] = useState(false);
  const row = (conversation: ConversationView) => {
    const mine =
      unread?.timelines.filter((t) => t.conversationId === conversation.conversationId) ?? [];
    const count = mine.reduce((sum, t) => sum + t.unread, 0);
    const mentioned = mine.some((t) => t.mentioned);
    return (
      <li key={conversation.conversationId}>
        <Link
          to={chatPath(conversation.conversationId)}
          className={[
            "conversation-row",
            conversation.conversationId === activeId ? "active" : "",
            conversation.member ? "" : "outsider",
          ].join(" ")}
        >
          <span className="glyph" aria-hidden>
            {conversation.kind === "dm" ? "@" : conversation.kind === "private" ? "🔒" : "#"}
          </span>
          <span className="conversation-name">{conversationLabel(conversation, accounts)}</span>
          {conversation.archived ? <span className="tag">已归档</span> : null}
          {count > 0 ? (
            <span className={mentioned ? "badge mention" : "badge"} aria-label={`${count} 条未读`}>
              {count}
            </span>
          ) : null}
        </Link>
      </li>
    );
  };
  const channels = conversations.filter((c) => c.kind !== "dm");
  const dms = conversations.filter((c) => c.kind === "dm");
  return (
    <nav className="sidebar" aria-label="会话">
      <div className="sidebar-heading">
        <h1>聊天</h1>
        <button
          type="button"
          className="icon-button"
          aria-label="新建会话"
          onClick={() => setCreating(true)}
        >
          +
        </button>
      </div>
      <form
        className="search-box"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const query = new FormData(event.currentTarget).get("q");
          if (typeof query === "string" && query.trim() !== "")
            navigate(`/app/search?q=${encodeURIComponent(query.trim())}`);
        }}
      >
        <input name="q" type="search" aria-label="搜索消息" placeholder="搜索消息" />
      </form>
      <div className="conversation-list">
        <h2>频道</h2>
        <ul>{channels.map(row)}</ul>
        <h2>私信</h2>
        <ul>{dms.map(row)}</ul>
      </div>
      {creating ? <NewConversation onClose={() => setCreating(false)} /> : null}
    </nav>
  );
}

function NewConversation({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const accounts = useAccounts().data ?? [];
  const owner = ownerOf(accounts);
  const [mode, setMode] = useState<"channel" | "dm">("channel");
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [other, setOther] = useState("");
  const [error, setError] = useState<unknown>(null);
  const open = async () => {
    try {
      const conversation =
        mode === "channel"
          ? await post<ConversationView>("/api/chat/channels", {
              requestId: crypto.randomUUID(),
              name,
              visibility,
            })
          : await post<ConversationView>("/api/chat/dms", {
              requestId: crypto.randomUUID(),
              other: Number(other),
            });
      qc.setQueryData<ConversationView[]>(keys.conversations, (old = []) =>
        old.some((c) => c.conversationId === conversation.conversationId)
          ? old
          : [...old, conversation],
      );
      onClose();
      navigate(chatPath(conversation.conversationId));
    } catch (cause) {
      setError(cause);
    }
  };
  return (
    <Dialog title="新建会话" onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void open();
        }}
      >
        <div className="segmented" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "channel"}
            onClick={() => setMode("channel")}
          >
            频道
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "dm"}
            onClick={() => setMode("dm")}
          >
            私信
          </button>
        </div>
        {mode === "channel" ? (
          <>
            <label>
              频道名称
              <input value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
            <label>
              可见性
              <select
                value={visibility}
                onChange={(event) => setVisibility(event.target.value as "public" | "private")}
              >
                <option value="public">公开</option>
                <option value="private">私有</option>
              </select>
            </label>
          </>
        ) : (
          <label>
            对方
            <select value={other} onChange={(event) => setOther(event.target.value)} required>
              <option value="">选择…</option>
              {accounts
                .filter((a) => a.active && a.accountId !== owner?.accountId)
                .map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.displayName}（@{a.handle}）
                  </option>
                ))}
            </select>
          </label>
        )}
        <ErrorLine error={error} />
        <button type="submit" className="button primary">
          {mode === "channel" ? "创建频道" : "打开私信"}
        </button>
      </form>
    </Dialog>
  );
}

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
        className="form"
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
        <label>
          邀请谁
          <select value={invitee} onChange={(event) => setInvitee(event.target.value)} required>
            <option value="">选择…</option>
            {accounts
              .filter((a) => a.active && !conversation.members.includes(a.accountId))
              .map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.displayName}（@{a.handle}）
                </option>
              ))}
          </select>
        </label>
        <ErrorLine error={error} />
        <button type="submit" className="button primary">
          邀请
        </button>
      </form>
    </Dialog>
  );
}

function Header({ conversation }: { conversation: ConversationView }) {
  const accounts = useAccounts().data ?? [];
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const act = async (action: "join" | "leave" | "archive") => {
    try {
      await post(`/api/chat/conversations/${conversation.conversationId}/${action}`, {
        requestId: crypto.randomUUID(),
      });
      setError(null);
    } catch (cause) {
      setError(cause);
    }
  };
  const channel = conversation.kind !== "dm";
  return (
    <header className="conversation-header">
      <Link to="/app" className="back" aria-label="返回会话列表">
        ‹
      </Link>
      <div className="title">
        <h1>{conversationLabel(conversation, accounts)}</h1>
        <span className="meta">
          {conversation.kind === "dm"
            ? "私信"
            : conversation.kind === "private"
              ? "私有频道"
              : "公开频道"}
          {" · "}
          {conversation.members.length} 位成员
          {conversation.archived ? " · 已归档" : ""}
        </span>
      </div>
      {channel && !conversation.archived ? (
        <div className="header-actions">
          {conversation.member ? (
            <>
              <button type="button" className="button" onClick={() => setInviting(true)}>
                邀请
              </button>
              <ConfirmButton label="离开" onConfirm={() => void act("leave")} />
            </>
          ) : (
            <button type="button" className="button primary" onClick={() => void act("join")}>
              加入
            </button>
          )}
          <ConfirmButton label="归档" danger onConfirm={() => void act("archive")} />
        </div>
      ) : null}
      {inviting ? <Invite conversation={conversation} onClose={() => setInviting(false)} /> : null}
      <ErrorLine error={error} />
    </header>
  );
}

function ConversationPanel(props: { id: number; thread: number | null; seq: number | null }) {
  const conversations = useConversations();
  const conversation = conversations.data?.find((c) => c.conversationId === props.id);
  if (conversation === undefined)
    return (
      <section className="conversation-panel">
        <p className="empty" role="alert">
          找不到这个会话。
        </p>
      </section>
    );
  const canWrite = conversation.member && !conversation.archived;
  const readonlyReason = conversation.archived
    ? "这个频道已归档，只能阅读。"
    : "你还没有加入这个频道，加入后才能发言。";
  return (
    <>
      <section
        className={props.thread === null ? "conversation-panel" : "conversation-panel with-thread"}
      >
        <Header conversation={conversation} />
        <Timeline
          timelineRef={{ conversation: props.id }}
          conversation={props.id}
          seq={props.thread === null ? props.seq : null}
          canWrite={canWrite}
          readonlyReason={readonlyReason}
        />
      </section>
      {props.thread === null ? null : (
        <aside className="thread-panel" aria-label="讨论串">
          <header>
            <h2>讨论串</h2>
            <Link to={chatPath(props.id)} className="icon-button" aria-label="关闭讨论串">
              ×
            </Link>
          </header>
          <Timeline
            timelineRef={{ thread: props.thread }}
            conversation={props.id}
            seq={props.seq}
            canWrite={canWrite}
            readonlyReason={readonlyReason}
          />
        </aside>
      )}
    </>
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
  if (account === undefined) return <p className="error">找不到 @{handle}。</p>;
  return failed === null ? <p className="splash">正在打开私信…</p> : <ErrorLine error={failed} />;
}

export function ChatPage() {
  const route = useRoute();
  if (route.page !== "chat") return null;
  const hasConversation = route.conversation !== null;
  return (
    <div className={hasConversation ? "chat chat-open" : "chat"}>
      <ConversationList activeId={route.conversation} />
      <main className="chat-main">
        {route.dm !== null ? (
          <OpenDirectMessage handle={route.dm} />
        ) : route.conversation === null ? (
          <div className="welcome">
            <h1>选择一个会话</h1>
            <p>从左边选一个频道或私信，或者新建一个。</p>
          </div>
        ) : (
          <ConversationPanel id={route.conversation} thread={route.thread} seq={route.seq} />
        )}
      </main>
    </div>
  );
}
