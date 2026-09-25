import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { redirectToLogin } from "./navigation.js";
import "./chat.css";

interface Channel {
  id: string;
  name: string;
  description: string;
  visibility: "public" | "private";
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

interface Message {
  id: string;
  channelId: string;
  rootId: null;
  author: { kind: "human"; id: "owner" };
  text: string;
  order: string;
  revision: string;
  createdAt: number;
}

interface Snapshot {
  channels: Channel[];
  cursor: number;
}

interface MessagePage {
  messages: Message[];
  nextBefore: string | null;
}

interface MessageWindow {
  messages: Message[];
  nextBefore: string | null;
  hasNewer: boolean;
}

interface ChatEvent<T = unknown> {
  seq: number;
  kind: string;
  channelId: string;
  payload: T;
}

type MobileView = "home" | "channels" | "chat";
type DialogState = { kind: "create" } | { kind: "settings"; channel: Channel } | null;
const maxLoadedMessages = 200;
const emptyMessageWindow: MessageWindow = { messages: [], nextBefore: null, hasNewer: false };

async function ownerJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: "application/json", ...init?.headers },
  });
  if (response.status === 401) {
    redirectToLogin();
    throw new Error("登录状态已失效");
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      typeof result === "object" && result !== null && "error" in result
        ? String(result.error)
        : "请求失败，请重试。",
    );
  }
  return result as T;
}

function mergeMessage(messages: Message[], incoming: Message): Message[] {
  if (messages.some((message) => message.id === incoming.id)) return messages;
  return [...messages, incoming].sort((left, right) => {
    const a = BigInt(left.order),
      b = BigInt(right.order);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function mergeMessages(messages: Message[], incoming: Message[]): Message[] {
  return incoming.reduce(mergeMessage, messages);
}

function cursorIncludingEvicted(messages: Message[]): string {
  return String(BigInt(messages.at(-1)!.order) + 1n);
}

function appendToLatestWindow(window: MessageWindow, incoming: Message[]): MessageWindow {
  const merged = mergeMessages(window.messages, incoming),
    overflow = Math.max(0, merged.length - maxLoadedMessages),
    evicted = merged.slice(0, overflow);
  return {
    ...window,
    messages: overflow ? merged.slice(-maxLoadedMessages) : merged,
    nextBefore: evicted.length ? cursorIncludingEvicted(evicted) : window.nextBefore,
  };
}

function prependOlderWindow(window: MessageWindow, page: MessagePage): MessageWindow {
  const merged = mergeMessages(window.messages, page.messages),
    overflow = Math.max(0, merged.length - maxLoadedMessages);
  return {
    messages: overflow ? merged.slice(0, maxLoadedMessages) : merged,
    nextBefore: page.nextBefore,
    hasNewer: window.hasNewer || overflow > 0,
  };
}

function timeLabel(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(value);
}

export function ChatPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messageWindows, setMessageWindows] = useState<Record<string, MessageWindow>>({});
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingLatestChannelId, setLoadingLatestChannelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("home");
  const [dialog, setDialog] = useState<DialogState>(null);
  const streamRef = useRef<EventSource | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const draft = selectedId ? (drafts[selectedId] ?? "") : "";
  selectedIdRef.current = selectedId;

  const closeDialog = useCallback(() => setDialog(null), []);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/owner/session", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then((response) => {
        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        if (!response.ok) throw new Error("Session request failed");
        setAuthenticated(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setAuthError("暂时无法确认登录状态，请刷新页面重试。");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    let active = true,
      checkingSession = false,
      expired = false;

    async function connectFromSnapshot() {
      try {
        const snapshot = await ownerJSON<Snapshot>("/api/owner/snapshot");
        if (!active) return;
        setChannels(snapshot.channels);
        setSelectedId((current) =>
          snapshot.channels.some((channel) => channel.id === current)
            ? current
            : (snapshot.channels.find((channel) => !channel.archived)?.id ??
              snapshot.channels[0]?.id ??
              null),
        );
        streamRef.current?.close();
        const stream = new EventSource(`/api/owner/events?cursor=${snapshot.cursor}`);
        streamRef.current = stream;
        stream.onopen = () => setLive(true);
        const expireSession = () => {
          if (!active || expired) return;
          expired = true;
          stream.close();
          if (streamRef.current === stream) streamRef.current = null;
          setAuthenticated(false);
          setLive(false);
          setChannels([]);
          setSelectedId(null);
          setMessageWindows({});
          setDrafts({});
          setError(null);
          redirectToLogin();
        };
        stream.addEventListener("auth_required", expireSession);
        stream.onerror = () => {
          if (!active || expired) return;
          setLive(false);
          if (checkingSession) return;
          checkingSession = true;
          void fetch("/api/owner/session", { headers: { Accept: "application/json" } })
            .then((response) => {
              if (response.status === 401) expireSession();
            })
            .catch(() => undefined)
            .finally(() => {
              checkingSession = false;
            });
        };

        const updateChannel = (event: Event) => {
          const update = JSON.parse((event as MessageEvent<string>).data) as ChatEvent<Channel>;
          setChannels((current) => {
            const found = current.some((channel) => channel.id === update.payload.id);
            return found
              ? current.map((channel) =>
                  channel.id === update.payload.id ? update.payload : channel,
                )
              : [...current, update.payload];
          });
        };
        stream.addEventListener("channel.created", updateChannel);
        stream.addEventListener("channel.updated", updateChannel);
        stream.addEventListener("message.created", (event) => {
          const update = JSON.parse((event as MessageEvent<string>).data) as ChatEvent<Message>;
          if (selectedIdRef.current !== update.channelId) return;
          setMessageWindows((current) => {
            const window = current[update.channelId] ?? emptyMessageWindow;
            return {
              [update.channelId]: window.hasNewer
                ? window
                : appendToLatestWindow(window, [update.payload]),
            };
          });
        });
        stream.addEventListener("snapshot_required", () => {
          stream.close();
          setLive(false);
          setMessageWindows({});
          setHistoryRefresh((revision) => revision + 1);
          if (active) void connectFromSnapshot();
        });
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "无法读取频道。");
      }
    }

    void connectFromSnapshot();
    return () => {
      active = false;
      streamRef.current?.close();
      streamRef.current = null;
    };
  }, [authenticated]);

  useEffect(() => {
    setMessageWindows((current) =>
      selectedId && current[selectedId] ? { [selectedId]: current[selectedId] } : {},
    );
  }, [selectedId]);

  useEffect(() => {
    if (!authenticated || !selectedId) return;
    const channelId = selectedId;
    let active = true;
    setLoadingMessages(true);
    ownerJSON<MessagePage>(`/api/owner/channels/${encodeURIComponent(channelId)}/messages`)
      .then((page) => {
        if (!active) return;
        setMessageWindows((current) => {
          const existing = current[channelId] ?? emptyMessageWindow,
            merged = mergeMessages(existing.messages, page.messages),
            overflow = Math.max(0, merged.length - maxLoadedMessages),
            evicted = merged.slice(0, overflow);
          return {
            [channelId]: {
              ...existing,
              messages: overflow ? merged.slice(-maxLoadedMessages) : merged,
              nextBefore: evicted.length ? cursorIncludingEvicted(evicted) : page.nextBefore,
            },
          };
        });
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "无法读取消息。");
      })
      .finally(() => {
        if (active) setLoadingMessages(false);
      });
    return () => {
      active = false;
    };
  }, [authenticated, selectedId, historyRefresh]);

  const selected = channels.find((channel) => channel.id === selectedId) ?? null;
  const currentWindow = selectedId
    ? (messageWindows[selectedId] ?? emptyMessageWindow)
    : emptyMessageWindow;
  const currentMessages = currentWindow.messages;
  const loadingLatest = selectedId !== null && loadingLatestChannelId === selectedId;

  async function logout() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Logout request failed");
      window.location.replace("/login");
    } catch {
      setError("退出失败，请重试。");
      setBusy(false);
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || selected.archived || !draft.trim()) return;
    const channelId = selected.id,
      submittedDraft = draft;
    setBusy(true);
    setError(null);
    try {
      const message = await ownerJSON<Message>(
        `/api/owner/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: submittedDraft }),
        },
      );
      if (selectedIdRef.current === channelId)
        setMessageWindows((current) => {
          const window = current[channelId] ?? emptyMessageWindow;
          return {
            [channelId]: appendToLatestWindow(window, [message]),
          };
        });
      setDrafts((current) =>
        current[channelId] === submittedDraft ? { ...current, [channelId]: "" } : current,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "消息发送失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function loadOlder() {
    if (!selectedId || !currentWindow.nextBefore) return;
    const channelId = selectedId,
      cursor = currentWindow.nextBefore;
    setLoadingOlder(true);
    setError(null);
    try {
      const page = await ownerJSON<MessagePage>(
        `/api/owner/channels/${encodeURIComponent(channelId)}/messages?before=${cursor}&limit=50`,
      );
      if (selectedIdRef.current !== channelId) return;
      setMessageWindows((current) => ({
        [channelId]: prependOlderWindow(current[channelId] ?? emptyMessageWindow, page),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取更早的消息。");
    } finally {
      setLoadingOlder(false);
    }
  }

  async function returnToLatest() {
    if (!selectedId) return;
    const channelId = selectedId;
    setLoadingLatestChannelId(channelId);
    setError(null);
    setMessageWindows((current) => {
      const window = current[channelId] ?? emptyMessageWindow;
      return { [channelId]: { ...window, hasNewer: false } };
    });
    try {
      const page = await ownerJSON<MessagePage>(
        `/api/owner/channels/${encodeURIComponent(channelId)}/messages`,
      );
      if (selectedIdRef.current !== channelId) return;
      setMessageWindows((current) => {
        const window = current[channelId] ?? emptyMessageWindow,
          newestLoadedOrder = page.messages.at(-1)?.order,
          liveAfterPage =
            newestLoadedOrder === undefined
              ? []
              : window.messages.filter(
                  (message) => BigInt(message.order) > BigInt(newestLoadedOrder),
                ),
          merged = mergeMessages(page.messages, liveAfterPage),
          overflow = Math.max(0, merged.length - maxLoadedMessages),
          evicted = merged.slice(0, overflow);
        return {
          [channelId]: {
            messages: overflow ? merged.slice(-maxLoadedMessages) : merged,
            nextBefore: evicted.length ? cursorIncludingEvicted(evicted) : page.nextBefore,
            hasNewer: false,
          },
        };
      });
    } catch (cause) {
      if (selectedIdRef.current === channelId) {
        setError(cause instanceof Error ? cause.message : "无法读取最新消息。");
        setMessageWindows((current) => {
          const window = current[channelId] ?? emptyMessageWindow;
          return { [channelId]: { ...window, hasNewer: true } };
        });
      }
    } finally {
      setLoadingLatestChannelId((current) => (current === channelId ? null : current));
    }
  }

  async function createChannel(input: {
    name: string;
    description: string;
    visibility: Channel["visibility"];
  }) {
    setBusy(true);
    setError(null);
    try {
      const channel = await ownerJSON<Channel>("/api/owner/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      setChannels((current) =>
        current.some((entry) => entry.id === channel.id) ? current : [...current, channel],
      );
      setSelectedId(channel.id);
      setMobileView("chat");
      setDialog(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "频道创建失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function updateChannel(input: {
    name: string;
    description: string;
    visibility: Channel["visibility"];
    archived: boolean;
  }) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const channel = await ownerJSON<Channel>(
        `/api/owner/channels/${encodeURIComponent(selected.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      setChannels((current) => current.map((entry) => (entry.id === channel.id ? channel : entry)));
      setDialog(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "频道更新失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  if (authError)
    return (
      <main className="page-shell">
        <section className="auth-card" aria-labelledby="page-title">
          <p className="eyebrow">MATE 控制面</p>
          <h1 id="page-title">Mate</h1>
          <p className="form-error" role="alert">
            {authError}
          </p>
        </section>
      </main>
    );
  if (!authenticated)
    return (
      <main className="page-shell">
        <section className="auth-card" aria-labelledby="page-title">
          <p className="eyebrow">MATE 控制面</p>
          <h1 id="page-title">Mate</h1>
          <p className="hint">正在确认登录状态…</p>
        </section>
      </main>
    );

  return (
    <div className="chat-shell" data-mobile-view={mobileView}>
      <aside className="navigation-rail" aria-label="主导航">
        <a className="mate-mark" href="/app" aria-label="Mate 对话">
          M
        </a>
        <button className="rail-item is-active" type="button" aria-current="page">
          <span aria-hidden="true">▤</span>
          <span>对话</span>
        </button>
        <div className="rail-spacer" />
        <button className="rail-item rail-logout" type="button" onClick={logout} disabled={busy}>
          <span aria-hidden="true">↪</span>
          <span>退出</span>
        </button>
      </aside>

      <aside className="channel-sidebar" aria-label="频道列表">
        <div className="sidebar-heading">
          <div>
            <p className="chat-eyebrow">工作空间</p>
            <h1>频道</h1>
          </div>
          <button
            className="icon-button create-channel-button"
            type="button"
            onClick={() => setDialog({ kind: "create" })}
            aria-label="新建频道"
            title="新建频道"
          >
            <span aria-hidden="true">＋</span>
          </button>
        </div>
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        <div className="channel-list" role="list">
          {channels.length === 0 ? (
            <div className="empty-list">
              <p>还没有频道</p>
              <span>创建一个频道，开始记录对话。</span>
            </div>
          ) : (
            channels.map((channel) => (
              <div className="channel-list-item" role="listitem" key={channel.id}>
                <button
                  className={`channel-row${selectedId === channel.id ? " is-selected" : ""}${channel.archived ? " is-archived" : ""}`}
                  type="button"
                  onClick={() => {
                    setSelectedId(channel.id);
                    setMobileView("chat");
                  }}
                >
                  <span className="channel-symbol" aria-hidden="true">
                    {channel.visibility === "private" ? "◈" : "#"}
                  </span>
                  <span className="channel-labels">
                    <span className="channel-name">{channel.name}</span>
                    {channel.archived && <span className="archived-label">已归档</span>}
                  </span>
                  {channel.visibility === "private" && <span className="private-label">私有</span>}
                </button>
              </div>
            ))
          )}
        </div>
        <div className="sidebar-footer">
          <span className={`live-dot${live ? " is-live" : ""}`} aria-hidden="true" />
          <span>{live ? "实时连接正常" : "正在连接…"}</span>
          <a className="text-button owner-nodes-link" href="/app/nodes">
            节点管理
          </a>
          <a className="text-button owner-nodes-link" href="/app/agents">
            Agent 同事
          </a>
          <button className="text-button" type="button" onClick={logout} disabled={busy}>
            退出登录
          </button>
        </div>
      </aside>

      <section className="mobile-welcome" aria-label="Mate 欢迎页">
        <div className="welcome-content">
          <span className="welcome-mark" aria-hidden="true">
            M
          </span>
          <p className="chat-eyebrow">MATE 控制面</p>
          <h1>让对话持续向前</h1>
          <p>进入频道，查看消息并继续交流。</p>
          <button type="button" onClick={() => setMobileView("channels")}>
            查看频道
          </button>
        </div>
      </section>

      <main className="conversation-panel" aria-label="频道对话">
        {selected ? (
          <>
            <header className="conversation-header">
              <button
                className="mobile-back-button"
                type="button"
                onClick={() => setMobileView("channels")}
                aria-label="返回频道列表"
              >
                ‹
              </button>
              <div className="conversation-title">
                <div className="title-line">
                  <span className="channel-symbol" aria-hidden="true">
                    {selected.visibility === "private" ? "◈" : "#"}
                  </span>
                  <h1>{selected.name}</h1>
                  {selected.archived && <span className="archived-pill">已归档</span>}
                </div>
                {selected.description && <p>{selected.description}</p>}
              </div>
              <button
                className="icon-button settings-button"
                type="button"
                onClick={() => setDialog({ kind: "settings", channel: selected })}
                aria-label="频道设置"
                title="频道设置"
              >
                ⋯
              </button>
            </header>

            <div className="message-list" aria-live="polite" aria-label="消息历史">
              {(currentWindow.hasNewer || loadingLatest) && (
                <button
                  className="load-older-button"
                  type="button"
                  onClick={returnToLatest}
                  disabled={loadingLatest || loadingOlder}
                >
                  {loadingLatest ? "正在读取最新消息…" : "返回最新消息"}
                </button>
              )}
              {currentWindow.nextBefore && (
                <button
                  className="load-older-button"
                  type="button"
                  onClick={loadOlder}
                  disabled={loadingOlder || loadingLatest}
                >
                  {loadingOlder ? "正在读取…" : "加载更早消息"}
                </button>
              )}
              {loadingMessages && currentMessages.length === 0 ? (
                <p className="conversation-placeholder">正在读取消息…</p>
              ) : currentMessages.length === 0 ? (
                <div className="conversation-empty">
                  <span className="empty-channel-symbol" aria-hidden="true">
                    {selected.visibility === "private" ? "◈" : "#"}
                  </span>
                  <h2>这是「{selected.name}」的开始</h2>
                  <p>发送第一条顶层消息，开始记录频道对话。</p>
                </div>
              ) : (
                currentMessages.map((message) => (
                  <article className="message-row" key={message.id}>
                    <div className="message-avatar" aria-hidden="true">
                      你
                    </div>
                    <div className="message-content">
                      <div className="message-meta">
                        <strong>你</strong>
                        <time dateTime={new Date(message.createdAt).toISOString()}>
                          {timeLabel(message.createdAt)}
                        </time>
                      </div>
                      <p>{message.text}</p>
                    </div>
                  </article>
                ))
              )}
            </div>

            {selected.archived ? (
              <div className="archived-notice">此频道已归档，消息只能查看。</div>
            ) : (
              <form className="message-composer" onSubmit={sendMessage}>
                <label className="visually-hidden" htmlFor="message-draft">
                  发送到 {selected.name}
                </label>
                <textarea
                  id="message-draft"
                  rows={2}
                  maxLength={20_000}
                  placeholder={`发送消息到 ${selected.name}`}
                  value={draft}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDrafts((current) => ({
                      ...current,
                      [selected.id]: value,
                    }));
                  }}
                />
                <div className="composer-footer">
                  <span>顶层消息会显示在频道时间线中</span>
                  <button type="submit" disabled={busy || !draft.trim()}>
                    发送
                  </button>
                </div>
              </form>
            )}
          </>
        ) : (
          <div className="conversation-empty no-channel">
            <span className="empty-channel-symbol" aria-hidden="true">
              #
            </span>
            <h2>选择一个频道</h2>
            <p>从左侧选择频道，或先创建一个频道。</p>
            <button type="button" onClick={() => setDialog({ kind: "create" })}>
              新建频道
            </button>
          </div>
        )}
      </main>

      <nav className="mobile-bottom-nav" aria-label="主导航">
        <button
          type="button"
          className={mobileView === "channels" ? "is-active" : ""}
          onClick={() => setMobileView("channels")}
          aria-current={mobileView === "channels" ? "page" : undefined}
        >
          <span aria-hidden="true">▤</span>
          对话
        </button>
      </nav>

      {dialog && (
        <ChannelDialog
          key={dialog.kind === "settings" ? dialog.channel.id : "new-channel"}
          kind={dialog.kind}
          channel={dialog.kind === "settings" ? dialog.channel : undefined}
          busy={busy}
          onClose={closeDialog}
          onCreate={createChannel}
          onUpdate={updateChannel}
        />
      )}
    </div>
  );
}

interface ChannelDialogProps {
  kind: "create" | "settings";
  channel?: Channel | undefined;
  busy: boolean;
  onClose: () => void;
  onCreate: (channel: {
    name: string;
    description: string;
    visibility: Channel["visibility"];
  }) => void;
  onUpdate: (channel: {
    name: string;
    description: string;
    visibility: Channel["visibility"];
    archived: boolean;
  }) => void;
}

function ChannelDialog({ kind, channel, busy, onClose, onCreate, onUpdate }: ChannelDialogProps) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const [name, setName] = useState(channel?.name ?? "");
  const [description, setDescription] = useState(channel?.description ?? "");
  const [visibility, setVisibility] = useState<Channel["visibility"]>(
    channel?.visibility ?? "public",
  );
  const [archived, setArchived] = useState(channel?.archived ?? false);

  useEffect(() => {
    const previouslyFocused =
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
      dialog = dialogRef.current;
    if (!dialog) return;
    const modal = dialog;
    const focusable = () =>
      Array.from(
        modal.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("hidden"));
    (
      modal.querySelector<HTMLElement>("[data-initial-focus]") ??
      modal.querySelector<HTMLElement>("[autofocus]") ??
      focusable()[0] ??
      modal
    ).focus();

    function trapFocus(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable(),
        first = items[0],
        last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        modal.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!modal.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", trapFocus);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = { name, description, visibility };
    if (kind === "create") onCreate(input);
    else onUpdate({ ...input, archived });
  }

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="channel-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-dialog-title"
        tabIndex={-1}
      >
        <div className="dialog-heading">
          <div>
            <p className="chat-eyebrow">频道管理</p>
            <h2 id="channel-dialog-title">{kind === "create" ? "新建频道" : "频道设置"}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <form className="channel-form" onSubmit={submit}>
          <label htmlFor="channel-name">频道名称</label>
          <input
            id="channel-name"
            data-initial-focus
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <label htmlFor="channel-description">简介</label>
          <textarea
            id="channel-description"
            rows={3}
            maxLength={500}
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
          <fieldset>
            <legend>谁可以发现这个频道</legend>
            <label className="radio-row">
              <input
                type="radio"
                name="channel-visibility"
                value="public"
                checked={visibility === "public"}
                onChange={() => setVisibility("public")}
              />
              <span>
                <strong>公开</strong>
                <small>频道名称和简介可被发现。</small>
              </span>
            </label>
            <label className="radio-row">
              <input
                type="radio"
                name="channel-visibility"
                value="private"
                checked={visibility === "private"}
                onChange={() => setVisibility("private")}
              />
              <span>
                <strong>私有</strong>
                <small>只有所有者和已加入的成员可以看到。</small>
              </span>
            </label>
          </fieldset>
          {kind === "settings" && (
            <label className="archive-row">
              <input
                type="checkbox"
                checked={archived}
                onChange={(event) => setArchived(event.currentTarget.checked)}
              />
              <span>归档频道，停止发送新消息</span>
            </label>
          )}
          <div className="dialog-actions">
            <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="submit" disabled={busy || !name.trim()}>
              {busy ? "正在保存…" : kind === "create" ? "创建频道" : "保存更改"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
