import type { Message } from "../conversation-responses.js";
import { MessageTasks, TaskCreationForm, type MessageTaskControls } from "./message-tasks.js";

type ConversationThreadProps = {
  threadRoot: Message;
  threadReplies: Message[];
  openMenuId: string | null;
  onToggleMenu: (id: string) => void;
  onQuote: (message: Message) => void;
  onReply: (message: Message) => void;
  onComposeReply: (message: Message) => void;
  onClose: () => void;
} & MessageTaskControls;

export function ConversationThread({
  threadRoot,
  threadReplies,
  tasks,
  taskCreation,
  createTask,
  cancelTaskCreation,
  openTaskCreation,
  openMenuId,
  onToggleMenu,
  onQuote,
  onReply,
  onComposeReply,
  onClose,
}: ConversationThreadProps) {
  return (
    <aside className="thread-panel" aria-label="讨论串">
      <header>
        <button
          type="button"
          onClick={() => {
            onClose();
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
        {taskCreation?.message.id === threadRoot.id && taskCreation.position === "thread-root" && (
          <TaskCreationForm
            key={`${threadRoot.id}:thread-root`}
            message={threadRoot}
            onCancel={cancelTaskCreation}
            onCreate={(title) =>
              createTask({ message: threadRoot, position: "thread-root", title })
            }
          />
        )}
      </article>
      <div className="thread-replies">
        {threadReplies.map((reply) => (
          <article id={`message-${reply.id}`} key={reply.id} tabIndex={0}>
            <strong>{reply.author.kind === "human" ? "你" : "Agent"}</strong>
            <p>{reply.text}</p>
            <MessageTasks tasks={tasks} messageId={reply.id} />
            {taskCreation?.message.id === reply.id && taskCreation.position === "thread-reply" && (
              <TaskCreationForm
                key={`${reply.id}:thread-reply`}
                message={reply}
                onCancel={cancelTaskCreation}
                onCreate={(title) =>
                  createTask({ message: reply, position: "thread-reply", title })
                }
              />
            )}
            <div className="message-actions">
              <button
                type="button"
                className="message-menu-trigger"
                aria-label={`消息 ${reply.text} 的操作`}
                aria-expanded={openMenuId === reply.id}
                onClick={() => onToggleMenu(reply.id)}
              >
                ⋯
              </button>
              {openMenuId === reply.id && (
                <div className="message-menu" role="group" aria-label="消息操作">
                  <button
                    type="button"
                    onClick={() => {
                      onQuote(reply);
                    }}
                  >
                    普通回复（引用）
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onReply(threadRoot);
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
          onComposeReply(threadRoot);
        }}
      >
        回复讨论串
      </button>
    </aside>
  );
}
