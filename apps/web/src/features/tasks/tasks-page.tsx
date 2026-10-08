import {
  tasksResponseSchema,
  taskActivityResponseSchema,
  type Task,
  type Activity,
} from "./task-responses.js";
import { useEffect, useState } from "react";
import { redirectToLogin } from "../../navigation.js";

const taskColumns = [
  { status: "open", label: "待认领" },
  { status: "in_progress", label: "进行中" },
  { status: "done", label: "已完成" },
];

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskActivity, setTaskActivity] = useState<Activity[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    async function refresh() {
      try {
        const response = await fetch("/api/owner/tasks", {
          headers: { Accept: "application/json" },
        });
        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        if (!response.ok) throw new Error("任务看板暂时无法读取");
        const parsed = tasksResponseSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("任务看板暂时无法读取");
        const body = parsed.data;
        if (live) {
          setTasks(body.tasks);
          setError(null);
        }
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : "读取失败");
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!selectedTaskId) return;
    let live = true;
    void fetch(`/api/owner/tasks/${encodeURIComponent(selectedTaskId)}/activity`)
      .then(async (response) => {
        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        if (!response.ok) throw new Error("任务活动暂时无法读取");
        const parsed = taskActivityResponseSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("任务活动暂时无法读取");
        const body = parsed.data;
        if (live) setTaskActivity(body.events);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : "读取失败");
      });
    return () => {
      live = false;
    };
  }, [selectedTaskId, tasks]);

  return (
    <main className="page-shell">
      <section className="agents-card" aria-labelledby="task-board-title">
        <p className="eyebrow">MATE 控制面</p>
        <div className="agents-heading">
          <div>
            <h1 id="task-board-title">任务看板</h1>
            <p>任务以原消息为锚点；负责人不会改变对话权限。</p>
          </div>
          <a href="/app">返回对话</a>
        </div>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {taskColumns.map(({ status, label }) => (
          <section key={status} aria-label={label}>
            <h2>{label}</h2>
            <ul>
              {tasks
                .filter((task) => task.status === status)
                .map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedTaskId(task.id)}
                      aria-expanded={selectedTaskId === task.id}
                    >
                      {task.title}
                    </button>
                    <span> · {taskOwnerLabel(task)}</span>
                    <a
                      href={`/app?channel=${encodeURIComponent(task.channelId)}&message=${encodeURIComponent(task.messageId)}`}
                    >
                      查看原消息
                    </a>
                    {selectedTaskId === task.id && (
                      <ol aria-label="任务活动">
                        {taskActivity.map((event) => (
                          <li key={event.seq}>
                            {event.kind} · {event.actorKind === "human" ? "你" : event.actorId}
                            {event.note ? ` · ${event.note}` : ""}
                          </li>
                        ))}
                      </ol>
                    )}
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </section>
    </main>
  );
}

function taskOwnerLabel(task: Task) {
  return task.ownerAgentId ? (task.ownerAgentName ?? task.ownerAgentId) : "未认领";
}
