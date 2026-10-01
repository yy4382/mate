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
  rootId: string | null;
  quoteId?: string | null;
  replyCount?: number;
  recentReplies?: Message[];
  author: { kind: "human"; id: "owner" } | { kind: "agent"; id: string };
  text: string;
  order: string;
  createdAt: number;
}

interface Task {
  id: string;
  messageId: string;
  channelId: string;
  title: string;
  status: "open" | "in_progress" | "done";
  ownerAgentId: string | null;
  ownerAgentName?: string | null;
}

interface Snapshot {
  channels: Channel[];
  cursor: number;
}

interface MessagePage {
  messages: Message[];
  nextBefore: string | null;
}

type MessageContext =
  | { kind: "timeline"; messageId: string; page: MessagePage; hasNewer: boolean }
  | { kind: "thread"; messageId: string; thread: { root: Message; replies: Message[] } };

interface MessageWindow {
  messages: Message[];
  nextBefore: string | null;
  hasNewer: boolean;
}

interface Attachment {
  id: string;
  channelId: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  uploader: { kind: "human"; id: "owner" } | { kind: "agent"; id: string };
  createdAt: number;
}

interface ChatEvent<T = unknown> {
  seq: number;
  kind: string;
  channelId: string;
  payload: T;
}

type MobileView = "home" | "channels" | "chat" | "thread";
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
  const [pushState, setPushState] = useState<string | null>(null);
  const [pushReady, setPushReady] = useState<{
    registration: ServiceWorkerRegistration;
    key: Uint8Array<ArrayBuffer>;
  } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messageWindows, setMessageWindows] = useState<Record<string, MessageWindow>>({});
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [asTask, setAsTask] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskCreation, setTaskCreation] = useState<{
    message: Message;
    position: "timeline" | "thread-root" | "thread-reply";
  } | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingLatestChannelId, setLoadingLatestChannelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [fallbackRefresh, setFallbackRefresh] = useState(0);
  const [attachmentsByChannel, setAttachmentsByChannel] = useState<Record<string, Attachment[]>>(
    {},
  );
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const [live, setLive] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("home");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [threadRoot, setThreadRoot] = useState<Message | null>(null);
  const [threadReplies, setThreadReplies] = useState<Message[]>([]);
  const [replyTarget, setReplyTarget] = useState<{
    kind: "quote" | "thread";
    message: Message;
  } | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const streamRef = useRef<EventSource | null>(null);
  const threadRootIdRef = useRef<string | null>(null);
  const threadRequestRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  const handledDeepLinkRef = useRef<string | null>(null);
  const failedDeepLinkRef = useRef<string | null>(null);
  const draft = selectedId ? (drafts[selectedId] ?? "") : "";
  selectedIdRef.current = selectedId;
  threadRootIdRef.current = threadRoot?.id ?? null;

  const closeDialog = useCallback(() => setDialog(null), []);
  async function enablePush() {
    try {
      if (!pushReady) throw new Error("通知尚未就绪，请稍后重试。");
      if (Notification.permission === "denied")
        throw new Error("通知已被浏览器拒绝，请在浏览器设置中重新允许。");
      // Start subscription in this click handler so iOS preserves the user gesture.
      const subscription = await pushReady.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: pushReady.key,
      });
      await ownerJSON("/api/owner/push/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription),
      });
      setPushState("已开启通知");
    } catch (cause) {
      setPushState(cause instanceof Error ? cause.message : "无法开启通知");
    }
  }

  useEffect(() => {
    if (!authenticated || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
    let active = true;
    void Promise.all([
      navigator.serviceWorker.register("/sw.js"),
      ownerJSON<{ publicKey: string }>("/api/owner/push/public-key"),
    ])
      .then(([registration, { publicKey }]) => {
        if (!active) return;
        const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (char) =>
          char.charCodeAt(0),
        );
        setPushReady({ registration, key });
      })
      .catch(() => {
        if (active) setPushState("通知暂不可用，请刷新页面重试。");
      });
    return () => {
      active = false;
    };
  }, [authenticated]);
  const openThread = useCallback(async (message: Message) => {
    const request = ++threadRequestRef.current;
    threadRootIdRef.current = message.id;
    setThreadRoot(message);
    setThreadReplies([]);
    setMobileView("thread");
    setOpenMenuId(null);
    try {
      const thread = await ownerJSON<{ root: Message; replies: Message[] }>(
        `/api/owner/channels/${encodeURIComponent(message.channelId)}/threads/${encodeURIComponent(message.id)}`,
      );
      if (threadRequestRef.current !== request || selectedIdRef.current !== message.channelId)
        return;
      setThreadRoot(thread.root);
      setThreadReplies((current) => mergeMessages(thread.replies, current));
    } catch (cause) {
      if (threadRequestRef.current === request)
        setError(cause instanceof Error ? cause.message : "无法读取讨论串。");
    }
  }, []);

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
    let live = true;
    async function refreshTasks() {
      try {
        const result = await ownerJSON<{ tasks: Task[] }>("/api/owner/tasks");
        if (live) setTasks(result.tasks);
      } catch {
        /* Conversation remains usable while the task board reloads. */
      }
    }
    void refreshTasks();
    const timer = window.setInterval(() => void refreshTasks(), 3000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [authenticated]);

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
        const current = selectedIdRef.current,
          requestedChannelId = new URLSearchParams(window.location.search).get("channel"),
          initialSelection =
            snapshot.channels.find((channel) => channel.id === current)?.id ??
            snapshot.channels.find((channel) => channel.id === requestedChannelId)?.id ??
            snapshot.channels.find((channel) => !channel.archived)?.id ??
            snapshot.channels[0]?.id ??
            null;
        // The stream can deliver a buffered first event before React commits this state update.
        selectedIdRef.current = initialSelection;
        setSelectedId(initialSelection);
        if (requestedChannelId && initialSelection === requestedChannelId) setMobileView("chat");
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
          selectedIdRef.current = null;
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
          if (update.payload.rootId) {
            setThreadReplies((current) =>
              threadRootIdRef.current === update.payload.rootId
                ? mergeMessage(current, update.payload)
                : current,
            );
          }
          setMessageWindows((current) => {
            const window = current[update.channelId] ?? emptyMessageWindow;
            return {
              [update.channelId]: window.hasNewer
                ? window
                : update.payload.rootId
                  ? {
                      ...window,
                      messages: window.messages.map((message) =>
                        message.id === update.payload.rootId
                          ? {
                              ...message,
                              replyCount:
                                message.recentReplies?.some(
                                  (reply) => reply.id === update.payload.id,
                                ) ||
                                (message.recentReplies?.at(-1) &&
                                  BigInt(update.payload.order) <=
                                    BigInt(message.recentReplies.at(-1)!.order))
                                  ? (message.replyCount ?? 0)
                                  : (message.replyCount ?? 0) + 1,
                              recentReplies:
                                message.recentReplies?.some(
                                  (reply) => reply.id === update.payload.id,
                                ) ||
                                (message.recentReplies?.at(-1) &&
                                  BigInt(update.payload.order) <=
                                    BigInt(message.recentReplies.at(-1)!.order))
                                  ? (message.recentReplies ?? [])
                                  : [...(message.recentReplies ?? []), update.payload].slice(-3),
                            }
                          : message,
                      ),
                    }
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
    ++threadRequestRef.current;
    threadRootIdRef.current = null;
    setThreadRoot(null);
    setThreadReplies([]);
    setReplyTarget(null);
    setDeepLinkError(null);
    setMessageWindows((current) =>
      selectedId && current[selectedId] ? { [selectedId]: current[selectedId] } : {},
    );
  }, [selectedId]);

  useEffect(() => {
    if (!authenticated || !selectedId) return;
    const deepLink = new URLSearchParams(window.location.search);
    const linkedMessage = deepLink.get("message");
    if (
      deepLink.get("channel") === selectedId &&
      linkedMessage &&
      handledDeepLinkRef.current !== `message-${linkedMessage}` &&
      failedDeepLinkRef.current !== `message-${linkedMessage}`
    )
      return;
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
  }, [authenticated, selectedId, historyRefresh, fallbackRefresh]);

  useEffect(() => {
    if (!authenticated || !selectedId) return;
    const query = new URLSearchParams(window.location.search),
      channelId = query.get("channel"),
      messageId = query.get("message");
    if (!messageId || channelId !== selectedId) return;
    const targetId = `message-${messageId}`;
    if (handledDeepLinkRef.current === targetId || failedDeepLinkRef.current === targetId) return;
    let active = true;
    void ownerJSON<MessageContext>(
      `/api/owner/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/context`,
    )
      .then((context) => {
        if (!active || selectedIdRef.current !== channelId) return;
        if (context.kind === "thread") {
          threadRootIdRef.current = context.thread.root.id;
          setThreadRoot(context.thread.root);
          setThreadReplies(context.thread.replies);
          setMobileView("thread");
          void ownerJSON<MessagePage>(
            `/api/owner/channels/${encodeURIComponent(channelId)}/messages`,
          )
            .then((page) => {
              if (active && selectedIdRef.current === channelId)
                setMessageWindows({ [channelId]: { ...page, hasNewer: false } });
            })
            .catch(() => {});
        } else {
          setMessageWindows({
            [channelId]: { ...context.page, hasNewer: context.hasNewer },
          });
          setMobileView("chat");
        }
      })
      .catch((cause) => {
        if (!active || selectedIdRef.current !== channelId) return;
        if (cause instanceof Error && cause.message === "登录状态已失效") return;
        failedDeepLinkRef.current = targetId;
        setDeepLinkError("通知中的消息无法打开，已切换到频道最新消息。");
        setMobileView("chat");
        setFallbackRefresh((revision) => revision + 1);
      });
    return () => {
      active = false;
    };
  }, [authenticated, selectedId]);

  useEffect(() => {
    if (!authenticated || !selectedId) return;
    const channelId = selectedId;
    let active = true;
    setAttachmentError(null);
    setSelectedFile(null);
    if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    async function refreshAttachments() {
      try {
        const result = await ownerJSON<{ attachments: Attachment[] }>(
          `/api/owner/channels/${encodeURIComponent(channelId)}/attachments`,
        );
        if (active)
          setAttachmentsByChannel((current) => ({ ...current, [channelId]: result.attachments }));
      } catch (cause) {
        if (active)
          setAttachmentError(cause instanceof Error ? cause.message : "暂时无法读取频道附件。");
      }
    }
    void refreshAttachments();
    const interval = window.setInterval(() => void refreshAttachments(), 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [authenticated, selectedId]);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const channelId = query.get("channel"),
      messageId = query.get("message");
    if (!selectedId || selectedId !== channelId || !messageId) return;
    const targetId = `message-${messageId}`;
    if (handledDeepLinkRef.current === targetId) return;
    const target = document.getElementById(targetId);
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    handledDeepLinkRef.current = targetId;
  }, [selectedId, messageWindows, threadReplies]);

  const selected = channels.find((channel) => channel.id === selectedId) ?? null;
  const currentWindow = selectedId
    ? (messageWindows[selectedId] ?? emptyMessageWindow)
    : emptyMessageWindow;
  const currentMessages = currentWindow.messages;
  const currentAttachments = selectedId ? (attachmentsByChannel[selectedId] ?? []) : [];
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
          body: JSON.stringify({
            text: submittedDraft,
            ...(asTask ? { asTask: true } : {}),
            ...(replyTarget?.kind === "quote"
              ? { quoteId: replyTarget.message.id }
              : replyTarget?.kind === "thread"
                ? { rootId: replyTarget.message.rootId ?? replyTarget.message.id }
                : {}),
          }),
        },
      );
      if (replyTarget?.kind === "thread")
        setThreadReplies((current) => mergeMessage(current, message));
      if (selectedIdRef.current === channelId && !message.rootId)
        setMessageWindows((current) => {
          const window = current[channelId] ?? emptyMessageWindow;
          return {
            [channelId]: appendToLatestWindow(window, [message]),
          };
        });
      setDrafts((current) =>
        current[channelId] === submittedDraft ? { ...current, [channelId]: "" } : current,
      );
      setReplyTarget(null);
      setAsTask(false);
      if (asTask) {
        const result = await ownerJSON<{ tasks: Task[] }>("/api/owner/tasks");
        setTasks(result.tasks);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "消息发送失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function uploadAttachment() {
    if (!selected || selected.archived || !selectedFile || attachmentBusy) return;
    const channelId = selected.id,
      file = selectedFile;
    setAttachmentBusy(true);
    setAttachmentError(null);
    try {
      const result = await ownerJSON<{ attachment: Attachment }>(
        `/api/owner/channels/${encodeURIComponent(channelId)}/attachments`,
        {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-Mate-Filename": encodeURIComponent(file.name),
          },
          body: file,
        },
      );
      setAttachmentsByChannel((current) => ({
        ...current,
        [channelId]: [...(current[channelId] ?? []), result.attachment],
      }));
      setSelectedFile(null);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : "附件上传失败，请重试。");
    } finally {
      setAttachmentBusy(false);
    }
  }

  function openTaskCreation(
    message: Message,
    position: NonNullable<typeof taskCreation>["position"],
  ) {
    setTaskCreation({ message, position });
    setOpenMenuId(null);
  }

  function taskForm(message: Message, position: NonNullable<typeof taskCreation>["position"]) {
    if (taskCreation?.message.id !== message.id || taskCreation.position !== position) return null;
    return (
      <TaskCreationForm
        key={`${message.id}:${position}`}
        message={message}
        onCancel={() => setTaskCreation(null)}
        onCreate={async (title) => {
          const task = await ownerJSON<Task>("/api/owner/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messageId: message.id, title }),
          });
          setTasks((current) => [...current.filter((existing) => existing.id !== task.id), task]);
          setTaskCreation((current) =>
            current?.message.id === message.id && current.position === position ? null : current,
          );
        }}
      />
    );
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
        <div className="mobile-owner-actions">
          <button type="button" onClick={() => void enablePush()} disabled={!pushReady}>
            开启通知
          </button>
          <a href="/app/nodes">节点</a>
          <a href="/app/agents">Agent</a>
          {pushState && <span role="status">{pushState}</span>}
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
          <button
            className="text-button"
            type="button"
            onClick={() => void enablePush()}
            disabled={!pushReady}
          >
            开启通知
          </button>
          {pushState && <span role="status">{pushState}</span>}
          <span className={`live-dot${live ? " is-live" : ""}`} aria-hidden="true" />
          <span>{live ? "实时连接正常" : "正在连接…"}</span>
          <a className="text-button owner-nodes-link" href="/app/nodes">
            节点管理
          </a>
          <a className="text-button owner-nodes-link" href="/app/agents">
            Agent 同事
          </a>
          <a className="text-button owner-nodes-link" href="/app/tasks">
            任务看板
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
              {deepLinkError && (
                <p className="chat-error" role="alert">
                  {deepLinkError}
                </p>
              )}
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
                  <article
                    id={`message-${message.id}`}
                    className="message-row"
                    key={message.id}
                    tabIndex={0}
                  >
                    <div className="message-avatar" aria-hidden="true">
                      {message.author.id === "mate-system"
                        ? "M"
                        : message.author.kind === "agent"
                          ? "A"
                          : "你"}
                    </div>
                    <div className="message-content">
                      <div className="message-meta">
                        <strong>
                          {message.author.id === "mate-system"
                            ? "Mate"
                            : message.author.kind === "agent"
                              ? "Agent"
                              : "你"}
                        </strong>
                        <time dateTime={new Date(message.createdAt).toISOString()}>
                          {timeLabel(message.createdAt)}
                        </time>
                      </div>
                      {message.quoteId && (
                        <span className="quote-reference">
                          引用：
                          {currentMessages.find((entry) => entry.id === message.quoteId)?.text ??
                            message.quoteId}
                        </span>
                      )}
                      <p>{message.text}</p>
                      <MessageTasks tasks={tasks} messageId={message.id} />
                      {taskForm(message, "timeline")}
                      {!!message.replyCount && (
                        <button
                          type="button"
                          className="thread-preview"
                          onClick={() => void openThread(message)}
                        >
                          {message.replyCount} 条讨论串回复 ·{" "}
                          {(message.recentReplies ?? []).map((reply) => reply.text).join(" / ")}
                        </button>
                      )}
                    </div>
                    <div className="message-actions">
                      <button
                        type="button"
                        className="message-menu-trigger"
                        aria-label={`消息 ${message.text} 的操作`}
                        aria-expanded={openMenuId === message.id}
                        onClick={() =>
                          setOpenMenuId((current) => (current === message.id ? null : message.id))
                        }
                      >
                        ⋯
                      </button>
                      {openMenuId === message.id && (
                        <div className="message-menu" role="group" aria-label="消息操作">
                          <button
                            type="button"
                            onClick={() => {
                              setReplyTarget({ kind: "quote", message });
                              setOpenMenuId(null);
                              document.getElementById("message-draft")?.focus();
                            }}
                          >
                            普通回复（引用）
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setReplyTarget({ kind: "thread", message });
                              setOpenMenuId(null);
                              void openThread(message);
                            }}
                          >
                            讨论串回复
                          </button>
                          <button type="button" onClick={() => void openThread(message)}>
                            查看讨论串
                          </button>
                          <button
                            type="button"
                            onClick={() => openTaskCreation(message, "timeline")}
                          >
                            从消息建任务
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                ))
              )}
            </div>

            {(currentAttachments.length > 0 || attachmentError) && (
              <section className="conversation-attachments" aria-label="频道附件">
                <h2>附件</h2>
                {attachmentError && <p role="alert">{attachmentError}</p>}
                <ul>
                  {currentAttachments.map((attachment) => (
                    <li key={attachment.id}>
                      <a
                        href={`/api/owner/channels/${encodeURIComponent(attachment.channelId)}/attachments/${encodeURIComponent(attachment.id)}/content`}
                      >
                        {attachment.filename}
                      </a>
                      <span>{attachment.size} B</span>
                      <small>
                        {attachment.uploader.kind === "agent" ? "Agent 发布" : "你上传"}
                      </small>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {selected.archived ? (
              <div className="archived-notice">此频道已归档，消息只能查看。</div>
            ) : (
              <form className="message-composer" onSubmit={sendMessage}>
                {replyTarget && (
                  <div className="reply-context">
                    {replyTarget.kind === "quote" ? "普通回复，引用" : "讨论串回复"}：
                    {replyTarget.message.text}
                    <button
                      type="button"
                      onClick={() => setReplyTarget(null)}
                      aria-label="取消回复"
                    >
                      ×
                    </button>
                  </div>
                )}
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
                  <label>
                    <input
                      type="checkbox"
                      checked={asTask}
                      onChange={(event) => setAsTask(event.currentTarget.checked)}
                    />
                    作为任务发送
                  </label>
                  <span>
                    {replyTarget?.kind === "thread"
                      ? "只显示在讨论串中"
                      : "顶层消息会显示在频道时间线中"}
                  </span>
                  <div className="composer-actions">
                    <label className="attachment-picker">
                      添加附件
                      <input
                        ref={attachmentInputRef}
                        aria-label="添加附件"
                        type="file"
                        disabled={busy || attachmentBusy}
                        onChange={(event) =>
                          setSelectedFile(event.currentTarget.files?.[0] ?? null)
                        }
                      />
                    </label>
                    {selectedFile && (
                      <span className="selected-attachment">{selectedFile.name}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => void uploadAttachment()}
                      disabled={busy || attachmentBusy || !selectedFile}
                    >
                      {attachmentBusy ? "正在上传…" : "上传附件"}
                    </button>
                    <button type="submit" disabled={busy || !draft.trim()}>
                      发送
                    </button>
                  </div>
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

      {threadRoot && (
        <aside className="thread-panel" aria-label="讨论串">
          <header>
            <button
              type="button"
              onClick={() => {
                ++threadRequestRef.current;
                threadRootIdRef.current = null;
                setThreadRoot(null);
                setMobileView("chat");
              }}
              aria-label="关闭讨论串"
            >
              ‹
            </button>
            <h2>讨论串</h2>
          </header>
          <article className="thread-root">
            <strong>{threadRoot.author.kind === "human" ? "你" : "Agent"}</strong>
            <p>{threadRoot.text}</p>
            <MessageTasks tasks={tasks} messageId={threadRoot.id} />
            <button type="button" onClick={() => openTaskCreation(threadRoot, "thread-root")}>
              从消息建任务
            </button>
            {taskForm(threadRoot, "thread-root")}
          </article>
          <div className="thread-replies">
            {threadReplies.map((reply) => (
              <article id={`message-${reply.id}`} key={reply.id} tabIndex={0}>
                <strong>{reply.author.kind === "human" ? "你" : "Agent"}</strong>
                <p>{reply.text}</p>
                <MessageTasks tasks={tasks} messageId={reply.id} />
                {taskForm(reply, "thread-reply")}
                <div className="message-actions">
                  <button
                    type="button"
                    className="message-menu-trigger"
                    aria-label={`消息 ${reply.text} 的操作`}
                    aria-expanded={openMenuId === reply.id}
                    onClick={() =>
                      setOpenMenuId((current) => (current === reply.id ? null : reply.id))
                    }
                  >
                    ⋯
                  </button>
                  {openMenuId === reply.id && (
                    <div className="message-menu" role="group" aria-label="消息操作">
                      <button
                        type="button"
                        onClick={() => {
                          setReplyTarget({ kind: "quote", message: reply });
                          setOpenMenuId(null);
                          setMobileView("chat");
                          document.getElementById("message-draft")?.focus();
                        }}
                      >
                        普通回复（引用）
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setReplyTarget({ kind: "thread", message: threadRoot });
                          setOpenMenuId(null);
                          setMobileView("chat");
                          document.getElementById("message-draft")?.focus();
                        }}
                      >
                        讨论串回复
                      </button>
                      <button type="button" onClick={() => openTaskCreation(reply, "thread-reply")}>
                        从消息建任务
                      </button>
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
          <button
            type="button"
            className="thread-reply-button"
            onClick={() => {
              setReplyTarget({ kind: "thread", message: threadRoot });
              setMobileView("chat");
              document.getElementById("message-draft")?.focus();
            }}
          >
            回复讨论串
          </button>
        </aside>
      )}

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

function MessageTasks({ tasks, messageId }: { tasks: Task[]; messageId: string }) {
  return (
    <div className="message-tasks">
      {tasks
        .filter((task) => task.messageId === messageId)
        .map((task) => (
          <a key={task.id} className="message-task-card" href="/app/tasks">
            任务 ·{" "}
            {task.status === "done"
              ? "已完成"
              : task.status === "in_progress"
                ? "进行中"
                : "待认领"}{" "}
            · {task.title} · 负责人：{task.ownerAgentName ?? task.ownerAgentId ?? "无"}
          </a>
        ))}
    </div>
  );
}

function TaskCreationForm({
  message,
  onCreate,
  onCancel,
}: {
  message: Message;
  onCreate: (title: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(message.text.trim().slice(0, 200));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(title.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法建立任务");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="message-task-form" aria-label="创建任务" onSubmit={submit}>
      <label>
        任务标题
        <input
          ref={titleRef}
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          required
          maxLength={200}
          disabled={busy}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div>
        <button type="submit" disabled={busy || !title.trim()}>
          创建任务
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          取消
        </button>
      </div>
    </form>
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
