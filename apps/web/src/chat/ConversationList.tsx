import { AccountAvatar } from "../shell/AccountAvatar.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { Hash, Lock, Plus, Search } from "lucide-react";
import { useState, type ReactNode } from "react";
import { post } from "../shell/api.ts";
import { Link, chatPath, navigate, useRoute } from "../shell/router.tsx";
import { Badge, Button, Dialog, ErrorLine, Field, Input, Select, Tabs, cx } from "../shell/ui.tsx";
import { keys } from "./cache.ts";
import {
  accountName,
  conversationLabel,
  useMe,
  useAccounts,
  useConversations,
  useUnread,
} from "./data.ts";
import type { AccountView, ConversationView } from "./types.ts";

function KindIcon({
  conversation,
  accounts,
  me,
}: {
  conversation: ConversationView;
  accounts: readonly AccountView[];
  me: number | undefined;
}) {
  if (conversation.kind === "dm") {
    const otherId = conversation.members.find((id) => id !== me);
    return (
      <AccountAvatar size="xs" accountId={otherId} name={accountName(accounts, otherId ?? 0)} />
    );
  }
  return conversation.kind === "private" ? <Lock aria-hidden /> : <Hash aria-hidden />;
}

function Heading({ children, action }: { children: string; action?: ReactNode }) {
  return (
    <div className="mt-2 flex h-8 items-center justify-between pl-2 text-xs font-medium text-muted">
      <h2>{children}</h2>
      {action}
    </div>
  );
}

/** The conversations the human can see, grouped by kind, with search and "new conversation". */
export function ConversationList() {
  const route = useRoute();
  const activeId = route.page === "chat" ? route.conversation : null;
  const accounts = useAccounts().data ?? [];
  const me = useMe().data;
  const conversations = useConversations().data ?? [];
  const unread = useUnread().data;
  const [creating, setCreating] = useState(false);
  const row = (conversation: ConversationView) => {
    const mine =
      unread?.timelines.filter((t) => t.conversationId === conversation.conversationId) ?? [];
    const count = mine.reduce((sum, t) => sum + t.unread, 0);
    const mentioned = mine.some((t) => t.mentioned);
    const active = conversation.conversationId === activeId;
    return (
      <li key={conversation.conversationId}>
        <Link
          to={chatPath(conversation.conversationId)}
          {...(active ? { "aria-current": "page" as const } : {})}
          className={cx(
            "flex h-8 items-center gap-2 rounded-md border border-transparent px-2 text-sm no-underline hover:bg-border/50 aria-[current=page]:border-border aria-[current=page]:bg-background aria-[current=page]:font-medium [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted",
            conversation.member ? "text-foreground" : "text-muted",
          )}
        >
          <KindIcon conversation={conversation} accounts={accounts} me={me} />
          <span className="min-w-0 flex-1 truncate">
            {conversationLabel(conversation, accounts, me)}
          </span>
          {conversation.archived ? <Badge>已归档</Badge> : null}
          {count > 0 ? (
            <Badge tone={mentioned ? "solid" : "inverse"} aria-label={`${count} 条未读`}>
              {count}
            </Badge>
          ) : null}
        </Link>
      </li>
    );
  };
  const channels = conversations.filter((c) => c.kind !== "dm");
  const dms = conversations.filter((c) => c.kind === "dm");
  return (
    <nav aria-label="会话" className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-6 md:p-2">
      <h1 className="pb-4 text-2xl font-semibold tracking-tight md:hidden">聊天</h1>
      <form
        className="relative"
        role="search"
        aria-label="搜索消息"
        onSubmit={(event) => {
          event.preventDefault();
          const query = new FormData(event.currentTarget).get("q");
          if (typeof query === "string" && query.trim() !== "")
            navigate(`/app/search?q=${encodeURIComponent(query.trim())}`);
        }}
      >
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
        />
        <Input
          name="q"
          type="search"
          aria-label="搜索消息"
          placeholder="搜索消息"
          className="pl-9"
        />
      </form>
      <div className="min-h-0 flex-1 overflow-auto">
        <Heading
          action={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="新建会话"
              onClick={() => setCreating(true)}
            >
              <Plus aria-hidden />
            </Button>
          }
        >
          频道
        </Heading>
        <ul className="m-0 grid list-none gap-0.5 p-0">{channels.map(row)}</ul>
        <Heading>私信</Heading>
        <ul className="m-0 grid list-none gap-0.5 p-0">{dms.map(row)}</ul>
      </div>
      {creating ? <NewConversation onClose={() => setCreating(false)} /> : null}
    </nav>
  );
}

function NewConversation({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const accounts = useAccounts().data ?? [];
  const me = useMe().data;
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
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void open();
        }}
      >
        <Tabs
          value={mode}
          onValueChange={(value) => setMode(value as "channel" | "dm")}
          items={[
            { value: "channel", label: "频道" },
            { value: "dm", label: "私信" },
          ]}
        />
        {mode === "channel" ? (
          <>
            <Field label="频道名称">
              <Input value={name} onChange={(event) => setName(event.target.value)} required />
            </Field>
            <Field label="可见性">
              <Select
                value={visibility}
                onChange={(event) => setVisibility(event.target.value as "public" | "private")}
              >
                <option value="public">公开</option>
                <option value="private">私有</option>
              </Select>
            </Field>
          </>
        ) : (
          <Field label="对方">
            <Select value={other} onChange={(event) => setOther(event.target.value)} required>
              <option value="">选择…</option>
              {accounts
                .filter((a) => a.active && a.accountId !== me)
                .map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.displayName}（@{a.handle}）
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <ErrorLine error={error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary">
            {mode === "channel" ? "创建频道" : "打开私信"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
