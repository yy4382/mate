import type { Channel, Message } from "../conversation-responses.js";
import type { MessageWindow } from "../feed/message-window.js";
import type { TaskCreationPosition, useMessageTasks } from "./message-tasks.js";
import { MessageTasks } from "./message-tasks.js";

function timeLabel(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(value);
}
export function MessageTimeline({
  selected,
  currentWindow,
  loadingLatest,
  loadingOlder,
  loadingMessages,
  deepLinkError,
  returnToLatest,
  loadOlder,
  tasks,
  taskForm,
  openMenuId,
  onToggleMenu,
  onQuote,
  onReply,
  openThread,
  openTaskCreation,
}: {
  selected: Channel;
  currentWindow: MessageWindow;
  loadingLatest: boolean;
  loadingOlder: boolean;
  loadingMessages: boolean;
  deepLinkError: string | null;
  returnToLatest: () => Promise<void>;
  loadOlder: () => Promise<void>;
  tasks: ReturnType<typeof useMessageTasks>["tasks"];
  taskForm: ReturnType<typeof useMessageTasks>["taskForm"];
  openMenuId: string | null;
  onToggleMenu: (id: string) => void;
  onQuote: (message: Message) => void;
  onReply: (message: Message) => void;
  openThread: (message: Message) => Promise<void>;
  openTaskCreation: (message: Message, position: TaskCreationPosition) => void;
}) {
  const currentMessages = currentWindow.messages;
  return (
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
                onClick={() => onToggleMenu(message.id)}
              >
                ⋯
              </button>
              {openMenuId === message.id && (
                <div className="message-menu" role="group" aria-label="消息操作">
                  <button
                    type="button"
                    onClick={() => {
                      onQuote(message);
                    }}
                  >
                    普通回复（引用）
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onReply(message);
                    }}
                  >
                    讨论串回复
                  </button>
                  <button type="button" onClick={() => void openThread(message)}>
                    查看讨论串
                  </button>
                  <button type="button" onClick={() => openTaskCreation(message, "timeline")}>
                    从消息建任务
                  </button>
                </div>
              )}
            </div>
          </article>
        ))
      )}
    </div>
  );
}
