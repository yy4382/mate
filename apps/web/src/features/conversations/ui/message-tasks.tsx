import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Task } from "../../tasks/task-responses.js";
import type { Message } from "../conversation-responses.js";
import type { useMessageTasks } from "../feed/use-message-tasks.js";

export type MessageTaskControls = Pick<
  ReturnType<typeof useMessageTasks>,
  "tasks" | "taskCreation" | "openTaskCreation" | "cancelTaskCreation" | "createTask"
>;

function taskStatusLabel(status: Task["status"]) {
  if (status === "done") return "已完成";
  if (status === "in_progress") return "进行中";
  return "待认领";
}

export function MessageTasks({ tasks, messageId }: { tasks: Task[]; messageId: string }) {
  return (
    <div className="message-tasks">
      {tasks
        .filter((task) => task.messageId === messageId)
        .map((task) => (
          <a key={task.id} className="message-task-card" href="/app/tasks">
            任务 · {taskStatusLabel(task.status)} · {task.title} · 负责人：
            {task.ownerAgentName ?? task.ownerAgentId ?? "无"}
          </a>
        ))}
    </div>
  );
}

export function TaskCreationForm({
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
