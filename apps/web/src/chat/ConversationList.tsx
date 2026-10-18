import { useQueryClient } from "@tanstack/react-query";
import { AtSign, Hash, Lock, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { post } from "../shell/api.ts";
import { Link, chatPath, navigate, useRoute } from "../shell/router.tsx";
import { Badge, Button, Dialog, ErrorLine, Field, Input, Select, Tabs, cx } from "../shell/ui.tsx";
import { keys } from "./cache.ts";
import { conversationLabel, ownerOf, useAccounts, useConversations, useUnread } from "./data.ts";
import type { ConversationView } from "./types.ts";

const kindIcons: Record<ConversationView["kind"], ReactNode> = {
  dm: <AtSign aria-hidden />,
  private: <Lock aria-hidden />,
  public: <Hash aria-hidden />,
};

function Heading({ children }: { children: string }) {
  return <h2 className="px-2 pb-1 pt-4 text-xs font-medium text-muted">{children}</h2>;
}

/** The conversations the owner can see, grouped by kind, with search and "new conversation". */
export function ConversationList() {
  const route = useRoute();
  const activeId = route.page === "chat" ? route.conversation : null;
  const accounts = useAccounts().data ?? [];
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
            "flex h-9 items-center gap-2 rounded-md px-2 text-sm text-foreground no-underline hover:bg-border/50 aria-[current=page]:bg-border/60 aria-[current=page]:font-medium [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted",
            !conversation.member && "opacity-70",
          )}
        >
          {kindIcons[conversation.kind]}
          <span className="min-w-0 flex-1 truncate">
            {conversationLabel(conversation, accounts)}
          </span>
          {conversation.archived ? <Badge>已归档</Badge> : null}
          {count > 0 ? (
            <Badge tone={mentioned ? "solid" : "accent"} aria-label={`${count} 条未读`}>
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
      <div className="flex gap-2">
        <form
          className="min-w-0 flex-1"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            const query = new FormData(event.currentTarget).get("q");
            if (typeof query === "string" && query.trim() !== "")
              navigate(`/app/search?q=${encodeURIComponent(query.trim())}`);
          }}
        >
          <Input name="q" type="search" aria-label="搜索消息" placeholder="搜索消息" />
        </form>
        <Button
          variant="secondary"
          size="icon"
          aria-label="新建会话"
          onClick={() => setCreating(true)}
        >
          <Plus aria-hidden />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <Heading>频道</Heading>
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
                .filter((a) => a.active && a.accountId !== owner?.accountId)
                .map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.displayName}（@{a.handle}）
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <ErrorLine error={error} />
        <Button type="submit" variant="primary">
          {mode === "channel" ? "创建频道" : "打开私信"}
        </Button>
      </form>
    </Dialog>
  );
}
