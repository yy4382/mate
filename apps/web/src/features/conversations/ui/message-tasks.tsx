import { useEffect, useRef, useState, type FormEvent } from "react";
import { taskSchema, tasksResponseSchema, type Task } from "../../tasks/task-responses.js";
import type { Message } from "../conversation-responses.js";
import { ownerJSON, OwnerRequestError } from "../owner-request.js";

export type TaskCreationPosition = "timeline" | "thread-root" | "thread-reply";

/** Tasks stay attached to their exact message, independently of the open timeline or thread. */
export function useMessageTasks(authenticated: boolean) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskCreation, setTaskCreation] = useState<{
    message: Message;
    position: TaskCreationPosition;
  } | null>(null);

  useEffect(() => {
    if (!authenticated) return;
    let live = true;
    async function refreshTasks() {
      try {
        const result = await ownerJSON("/api/owner/tasks", tasksResponseSchema);
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

  async function refreshTasks() {
    const result = await ownerJSON("/api/owner/tasks", tasksResponseSchema);
    setTasks(result.tasks);
  }

  function openTaskCreation(message: Message, position: TaskCreationPosition) {
    setTaskCreation({ message, position });
  }

  function taskForm(message: Message, position: TaskCreationPosition) {
    if (taskCreation?.message.id !== message.id || taskCreation.position !== position) return null;
    return (
      <TaskCreationForm
        key={`${message.id}:${position}`}
        message={message}
        onCancel={() => setTaskCreation(null)}
        onCreate={async (title) => {
          const task = await ownerJSON("/api/owner/tasks", taskSchema, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messageId: message.id, title }),
          }).catch((cause: unknown) => {
            // A gateway/server failure can occur after the control plane committed.
            if (cause instanceof OwnerRequestError && cause.status < 500) throw cause;
            throw new Error(
              "创建提交结果未确认，可能已创建。请刷新查看任务列表，再决定是否创建另一项。",
            );
          });
          setTasks((current) => [...current.filter((existing) => existing.id !== task.id), task]);
          setTaskCreation((current) =>
            current?.message.id === message.id && current.position === position ? null : current,
          );
        }}
      />
    );
  }

  return { tasks, refreshTasks, openTaskCreation, taskForm };
}

export function MessageTasks({ tasks, messageId }: { tasks: Task[]; messageId: string }) {
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
