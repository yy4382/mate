import { z } from "zod";
import { ownerReminderSchema } from "@mate/protocol/owner";
import { useEffect, useState } from "react";
import { redirectToLogin } from "../../navigation.js";
const reminderSchema = ownerReminderSchema
  .pick({ id: true, text: true, dueAt: true, state: true })
  .extend({
    firing: z.looseObject({ handledAt: z.number().nullish() }).nullish(),
  })
  .loose();
const remindersResponseSchema = z.looseObject({ reminders: z.array(reminderSchema) });
type Reminder = z.infer<typeof reminderSchema>;
export function RemindersPage() {
  const agentId = window.location.pathname.split("/")[3] ?? "";
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    async function refresh() {
      try {
        const response = await fetch(`/api/owner/agents/${encodeURIComponent(agentId)}/reminders`);
        if (response.status === 401) {
          redirectToLogin();
          return;
        }
        if (!response.ok) throw new Error("提醒暂时无法读取");
        const parsed = remindersResponseSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("提醒暂时无法读取");
        const body = parsed.data;
        if (live) {
          setReminders(body.reminders);
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
  }, [agentId]);
  return (
    <main className="page-shell">
      <section className="agents-card" aria-labelledby="reminders-title">
        <p className="eyebrow">MATE 控制面</p>
        <div className="agents-heading">
          <h1 id="reminders-title">Agent 提醒</h1>
          <a href="/app/agents">返回 Agent</a>
        </div>
        <p>此页只读。Agent 自己安排、改期和取消提醒。</p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {reminders.length === 0 ? (
          <p>暂无提醒。</p>
        ) : (
          <ul>
            {reminders.map((reminder) => (
              <li key={reminder.id}>
                <strong>{reminder.text}</strong> ·{" "}
                {new Date(reminder.dueAt).toLocaleString("zh-CN")} ·{" "}
                {reminder.state === "active"
                  ? "待触发"
                  : reminder.state === "cancelled"
                    ? "已取消"
                    : reminder.firing?.handledAt
                      ? "已处理"
                      : "已触发，等待 Agent 处理"}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
