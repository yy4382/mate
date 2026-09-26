import { useEffect, useState } from "react";
import { redirectToLogin } from "./navigation.js";

interface Task {
  id: string;
  messageId: string;
  channelId: string;
  title: string;
  status: "open" | "in_progress" | "done";
  ownerAgentId: string | null;
  ownerAgentName?: string | null;
  version: number;
  updatedAt: number;
}
interface Activity {
  seq: number;
  actorKind: string;
  actorId: string;
  kind: string;
  note: string;
  createdAt: number;
}
const labels = { open: "待认领", in_progress: "进行中", done: "已完成" };

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
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
        const body = (await response.json()) as { tasks: Task[] };
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
    if (!selected) return;
    let live = true;
    void fetch(`/api/owner/tasks/${encodeURIComponent(selected)}/activity`)
      .then(async (response) => {
        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        if (!response.ok) throw new Error("任务活动暂时无法读取");
        const body = (await response.json()) as { events: Activity[] };
        if (live) setActivity(body.events);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : "读取失败");
      });
    return () => {
      live = false;
    };
  }, [selected, tasks]);
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
        {(["open", "in_progress", "done"] as const).map((status) => (
          <section key={status} aria-label={labels[status]}>
            <h2>{labels[status]}</h2>
            <ul>
              {tasks
                .filter((task) => task.status === status)
                .map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(task.id)}
                      aria-expanded={selected === task.id}
                    >
                      {task.title}
                    </button>
                    <span>
                      {" "}
                      · {task.ownerAgentId ? (task.ownerAgentName ?? task.ownerAgentId) : "未认领"}
                    </span>
                    <a href={`/app?channel=${encodeURIComponent(task.channelId)}`}>查看原消息</a>
                    {selected === task.id && (
                      <ol aria-label="任务活动">
                        {activity.map((event) => (
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
