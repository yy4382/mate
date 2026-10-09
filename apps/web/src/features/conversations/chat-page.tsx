import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { jsonRequest } from "../../http-json.js";
import { redirectToLogin } from "../../navigation.js";
import {
  channelSchema,
  messageSchema,
  type Channel,
  type Message,
} from "./conversation-responses.js";
import { useConversationAttachments } from "./feed/use-conversation-attachments.js";
import { useConversationFeed } from "./feed/use-conversation-feed.js";
import { useConversationThread } from "./feed/use-conversation-thread.js";
import { useMessageTasks, type TaskCreationPosition } from "./feed/use-message-tasks.js";
import { useOwnerPush } from "./feed/use-owner-push.js";
import { ownerJSON } from "./owner-request.js";
import { ChannelDialog, type ChannelDraft, type ChannelSettings } from "./ui/channel-dialog.js";
import { ConversationComposer, type ReplyTarget } from "./ui/conversation-composer.js";
import { ConversationSidebar } from "./ui/conversation-sidebar.js";
import { ConversationThread } from "./ui/conversation-thread.js";
import { MessageTimeline } from "./ui/message-timeline.js";

// Message details follow mobile layout so their thread rules take precedence.
import "./styles/shell.css";
import "./styles/conversation.css";
import "./styles/dialog.css";
import "./styles/mobile.css";
import "./styles/message-details.css";

type MobileView = "home" | "channels" | "chat" | "thread";
type DialogState = { kind: "create" } | { kind: "settings"; channel: Channel } | null;

function replyReference(target: ReplyTarget | null) {
  if (target?.kind === "quote") return { quoteId: target.message.id };
  if (target?.kind === "thread") return { rootId: target.message.rootId ?? target.message.id };
  return {};
}

export function ChatPage() {
  const [authenticated, setAuthenticated] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [asTask, setAsTask] = useState(false);
  const messageTasks = useMessageTasks(authenticated);
  const { tasks, taskCreation, createTask, cancelTaskCreation } = messageTasks;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<MobileView>("home");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const draft = selectedId ? (drafts[selectedId] ?? "") : "";
  selectedIdRef.current = selectedId;
  const { pushState, pushReady, enablePush } = useOwnerPush(authenticated);
  const {
    currentAttachments,
    attachmentError,
    attachmentBusy,
    selectedFile,
    setSelectedFile,
    attachmentInputRef,
    uploadAttachment,
  } = useConversationAttachments({ authenticated, selectedId });
  const thread = useConversationThread({ selectedIdRef, onError: setError });
  const { threadRoot, threadReplies } = thread;
  const expireSession = useCallback(() => {
    setAuthenticated(false);
    setDrafts({});
    setError(null);
  }, []);
  const feed = useConversationFeed({
    authenticated,
    selectedId,
    selectedIdRef,
    onSelect: setSelectedId,
    onSessionExpired: expireSession,
    onMobileView: setMobileView,
    onError: setError,
    receiveStreamReply: thread.receiveStreamReply,
    installThread: thread.installThread,
  });
  const {
    channels,
    currentWindow,
    messageWindows,
    loadingMessages,
    loadingOlder,
    loadingLatest,
    deepLinkError,
    live,
    handledDeepLinkRef,
    loadOlder,
    returnToLatest,
  } = feed;

  const closeDialog = useCallback(() => setDialog(null), []);
  function openThread(message: Message) {
    const opening = thread.open(message);
    setMobileView("thread");
    setOpenMenuId(null);
    return opening;
  }

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
    thread.reset();
    setReplyTarget(null);
  }, [selectedId]);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const channelId = query.get("channel");
    const messageId = query.get("message");
    if (!selectedId || selectedId !== channelId || !messageId) return;
    const targetId = `message-${messageId}`;
    if (handledDeepLinkRef.current === targetId) return;
    const target = document.getElementById(targetId);
    if (!target) return;
    target.scrollIntoView({ block: "center" });
    handledDeepLinkRef.current = targetId;
  }, [selectedId, messageWindows, threadReplies]);

  const selected = channels.find((channel) => channel.id === selectedId) ?? null;

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
    const channelId = selected.id;
    const submittedDraft = draft;
    setBusy(true);
    setError(null);
    try {
      const message = await ownerJSON(
        `/api/owner/channels/${encodeURIComponent(channelId)}/messages`,
        messageSchema,
        jsonRequest("POST", {
          text: submittedDraft,
          ...(asTask ? { asTask: true } : {}),
          ...replyReference(replyTarget),
        }),
      );
      if (replyTarget?.kind === "thread") thread.appendSubmittedReply(message);
      feed.appendSubmittedMessage(channelId, message);
      setDrafts((current) =>
        current[channelId] === submittedDraft ? { ...current, [channelId]: "" } : current,
      );
      setReplyTarget(null);
      setAsTask(false);
      if (asTask) {
        await messageTasks.refreshTasks();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "消息发送失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  function toggleMenu(id: string) {
    setOpenMenuId((current) => (current === id ? null : id));
  }
  function quoteMessage(message: Message) {
    setReplyTarget({ kind: "quote", message });
    setOpenMenuId(null);
    document.getElementById("message-draft")?.focus();
  }
  function replyInThread(message: Message) {
    setReplyTarget({ kind: "thread", message });
    setOpenMenuId(null);
    void openThread(message);
  }
  function composeThreadReply(message: Message) {
    setReplyTarget({ kind: "thread", message });
    setOpenMenuId(null);
    setMobileView("chat");
    document.getElementById("message-draft")?.focus();
  }
  function quoteFromThread(message: Message) {
    setReplyTarget({ kind: "quote", message });
    setOpenMenuId(null);
    setMobileView("chat");
    document.getElementById("message-draft")?.focus();
  }
  function composeRootReply(message: Message) {
    setReplyTarget({ kind: "thread", message });
    setMobileView("chat");
    document.getElementById("message-draft")?.focus();
  }
  function closeThread() {
    thread.close();
    setMobileView("chat");
  }

  function openTaskCreation(message: Message, position: TaskCreationPosition) {
    messageTasks.openTaskCreation(message, position);
    setOpenMenuId(null);
  }

  async function createChannel(input: ChannelDraft) {
    setBusy(true);
    setError(null);
    try {
      const channel = await ownerJSON(
        "/api/owner/channels",
        channelSchema,
        jsonRequest("POST", input),
      );
      feed.channelCreated(channel);
      setSelectedId(channel.id);
      setMobileView("chat");
      setDialog(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "频道创建失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function updateChannel(input: ChannelSettings) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const channel = await ownerJSON(
        `/api/owner/channels/${encodeURIComponent(selected.id)}`,
        channelSchema,
        jsonRequest("PATCH", input),
      );
      feed.channelUpdated(channel);
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

      <ConversationSidebar
        channels={channels}
        selectedId={selectedId}
        error={error}
        busy={busy}
        live={live}
        pushReady={pushReady}
        pushState={pushState}
        enablePush={enablePush}
        logout={logout}
        onCreateChannel={() => setDialog({ kind: "create" })}
        onSelectChannel={(id) => {
          setSelectedId(id);
          setMobileView("chat");
        }}
      />

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

            <MessageTimeline
              selected={selected}
              currentWindow={currentWindow}
              loadingLatest={loadingLatest}
              loadingOlder={loadingOlder}
              loadingMessages={loadingMessages}
              deepLinkError={deepLinkError}
              returnToLatest={returnToLatest}
              loadOlder={loadOlder}
              tasks={tasks}
              taskCreation={taskCreation}
              createTask={createTask}
              cancelTaskCreation={cancelTaskCreation}
              openMenuId={openMenuId}
              onToggleMenu={toggleMenu}
              onQuote={quoteMessage}
              onReply={replyInThread}
              openThread={openThread}
              openTaskCreation={openTaskCreation}
            />

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
              <ConversationComposer
                selected={selected}
                replyTarget={replyTarget}
                draft={draft}
                asTask={asTask}
                busy={busy}
                attachmentBusy={attachmentBusy}
                selectedFile={selectedFile}
                attachmentInputRef={attachmentInputRef}
                sendMessage={sendMessage}
                onCancelReply={() => setReplyTarget(null)}
                onDraftChange={(value) =>
                  setDrafts((current) => ({ ...current, [selected.id]: value }))
                }
                onAsTaskChange={setAsTask}
                onFileChange={setSelectedFile}
                onUpload={() => uploadAttachment(selected)}
              />
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
        <ConversationThread
          threadRoot={threadRoot}
          threadReplies={threadReplies}
          tasks={tasks}
          taskCreation={taskCreation}
          createTask={createTask}
          cancelTaskCreation={cancelTaskCreation}
          openTaskCreation={openTaskCreation}
          openMenuId={openMenuId}
          onToggleMenu={toggleMenu}
          onQuote={quoteFromThread}
          onReply={composeThreadReply}
          onComposeReply={composeRootReply}
          onClose={closeThread}
        />
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
