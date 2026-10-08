import { useEffect, useState } from "react";
import { jsonRequest } from "../../../http-json.js";
import { taskSchema, tasksResponseSchema, type Task } from "../../tasks/task-responses.js";
import type { Message } from "../conversation-responses.js";
import { ownerJSON, OwnerRequestError } from "../owner-request.js";

export type TaskCreationPosition = "timeline" | "thread-root" | "thread-reply";
type TaskCreation = { message: Message; position: TaskCreationPosition };

/** Tasks stay attached to their exact message, independently of the open timeline or thread. */
export function useMessageTasks(authenticated: boolean) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskCreation, setTaskCreation] = useState<TaskCreation | null>(null);

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

  function cancelTaskCreation() {
    setTaskCreation(null);
  }

  async function createTask({ message, position, title }: TaskCreation & Pick<Task, "title">) {
    const task = await ownerJSON(
      "/api/owner/tasks",
      taskSchema,
      jsonRequest("POST", { messageId: message.id, title }),
    ).catch((cause: unknown) => {
      // A gateway/server failure can occur after the control plane committed.
      if (cause instanceof OwnerRequestError && cause.status < 500) throw cause;
      throw new Error("创建提交结果未确认，可能已创建。请刷新查看任务列表，再决定是否创建另一项。");
    });
    setTasks((current) => [...current.filter((existing) => existing.id !== task.id), task]);
    setTaskCreation((current) =>
      current?.message.id === message.id && current.position === position ? null : current,
    );
  }

  return {
    tasks,
    taskCreation,
    refreshTasks,
    openTaskCreation,
    cancelTaskCreation,
    createTask,
  };
}
