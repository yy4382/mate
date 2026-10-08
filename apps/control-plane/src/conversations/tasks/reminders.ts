import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { OwnerReminder } from "@mate/protocol/owner";
import { z } from "zod";
import { AgentToolRefusal } from "../errors.js";
import { reminderRowSchema, toReminder } from "../rows.js";
import { type ConversationToolActions, defineConversationTool } from "../tools/actions.js";
import { conversationToolDefinitions } from "../tools/contracts.js";
import type { ConversationDirectory } from "../channels/directory.js";
import type { TaskService } from "./service.js";
const dueReminderBatchSize = 100;
export class ReminderService {
  constructor(
    private readonly db: Database.Database,
    private readonly directory: ConversationDirectory,
    private readonly readTask: TaskService["readTask"],
    private readonly now: () => number,
    private readonly toolActions: ConversationToolActions,
  ) {}

  listAgentReminders(
    agentId: string,
  ): Array<OwnerReminder & { firing: { firedAt: number; handledAt: number | null } | null }> {
    const rows = reminderRowSchema
      .array()
      .parse(
        this.db
          .prepare(
            "SELECT id,agent_id,channel_id,task_id,text,due_at,state,version,created_at,updated_at FROM owner_reminders WHERE agent_id=? ORDER BY due_at DESC,id",
          )
          .all(agentId),
      );
    return rows.map((row) => {
      const firing = z
        .looseObject({ firedAt: z.number(), handledAt: z.number().nullable() })
        .optional()
        .parse(
          this.db
            .prepare(
              "SELECT fired_at AS firedAt,handled_at AS handledAt FROM owner_reminder_firings WHERE reminder_id=?",
            )
            .get(row.id),
        );
      return { ...toReminder(row), firing: firing ?? null };
    });
  }

  private readReminder(id: string): OwnerReminder | undefined {
    const row = reminderRowSchema
      .optional()
      .parse(
        this.db
          .prepare(
            "SELECT id,agent_id,channel_id,task_id,text,due_at,state,version,created_at,updated_at FROM owner_reminders WHERE id=?",
          )
          .get(id),
      );
    return row && toReminder(row);
  }

  /** Due time and delivery are committed together, independent of node connectivity. */
  fireDueReminders(): number {
    return this.db
      .transaction(() => {
        const due = z
          .looseObject({ id: z.string(), agent_id: z.string() })
          .array()
          .parse(
            this.db
              .prepare(
                "SELECT id,agent_id FROM owner_reminders WHERE state='active' AND due_at<=? ORDER BY due_at,id LIMIT ?",
              )
              .all(this.now(), dueReminderBatchSize),
          );
        for (const candidate of due) {
          const reminder = this.readReminder(candidate.id)!;
          const channel = this.directory.getOrCreateAgentDirectChannel(reminder.agentId);
          if (!channel) continue;
          const order = z
            .looseObject({ next: z.number() })
            .parse(
              this.db
                .prepare(
                  "SELECT COALESCE(MAX(order_seq),0)+1 AS next FROM owner_messages WHERE channel_id=?",
                )
                .get(channel.id),
            );
          const messageId = randomUUID();
          const deliveryId = randomUUID();
          const at = this.now();
          this.db
            .prepare(
              "INSERT INTO owner_messages(id,channel_id,order_seq,text,author_kind,author_id,internal_kind,created_at) VALUES(?,?,?,?,'agent',?,'reminder',?)",
            )
            .run(messageId, channel.id, order.next, `提醒：${reminder.text}`, reminder.agentId, at);
          this.db
            .prepare(
              "INSERT INTO owner_message_deliveries(id,message_id,channel_id,recipient_kind,recipient_id,state,created_at) VALUES(?,?,?,'agent',?,'pending',?)",
            )
            .run(deliveryId, messageId, channel.id, reminder.agentId, at);
          this.db
            .prepare(
              "INSERT INTO owner_reminder_firings(id,reminder_id,agent_id,fired_at,delivery_id) VALUES(?,?,?,?,?)",
            )
            .run(randomUUID(), reminder.id, reminder.agentId, at, deliveryId);
          this.db
            .prepare(
              "UPDATE owner_reminders SET state='fired',version=version+1,updated_at=? WHERE id=?",
            )
            .run(at, reminder.id);
        }
        this.syncHandledReminders();
        return due.length;
      })
      .immediate();
  }

  syncHandledReminders(): void {
    this.db
      .prepare(
        `UPDATE owner_reminder_firings SET handled_at=(
      SELECT d.handled_at FROM owner_message_deliveries d
      WHERE d.id=owner_reminder_firings.delivery_id
    ) WHERE handled_at IS NULL AND EXISTS (
      SELECT 1 FROM owner_message_deliveries d
      JOIN owner_agent_runs r
        ON r.agent_id=owner_reminder_firings.agent_id AND r.state='completed'
           AND r.input_end_seq>=d.seq AND r.completed_at=d.handled_at
      JOIN owner_message_deliveries seed ON seed.id=r.delivery_id AND seed.channel_id=d.channel_id
      WHERE d.id=owner_reminder_firings.delivery_id AND d.state='handled' AND seed.seq<=d.seq
    )`,
      )
      .run();
  }

  agentTools() {
    return {
      "reminders.create": defineConversationTool(
        conversationToolDefinitions["reminders.create"],
        (run, toolCallId, args) => {
          this.directory.requireAgentConversation(run.agent_id, args.conversationId);
          return this.toolActions.record(run, toolCallId, "reminders.create", args, () => {
            if (args.taskId) {
              const task = this.readTask(args.taskId);
              if (!task || task.channelId !== args.conversationId)
                throw new AgentToolRefusal("Task is not in this conversation");
            }
            const id = randomUUID();
            const at = this.now();
            this.db
              .prepare(
                "INSERT INTO owner_reminders(id,agent_id,channel_id,task_id,text,due_at,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'active',?,?)",
              )
              .run(
                id,
                run.agent_id,
                args.conversationId,
                args.taskId ?? null,
                args.text,
                args.dueAt,
                at,
                at,
              );
            return this.readReminder(id)!;
          });
        },
      ),

      "reminders.reschedule": defineConversationTool(
        conversationToolDefinitions["reminders.reschedule"],
        (run, toolCallId, args) => {
          const reminder = this.readReminder(args.reminderId);
          if (!reminder || reminder.agentId !== run.agent_id)
            throw new AgentToolRefusal("Reminder is not available");
          return this.toolActions.record(run, toolCallId, "reminders.reschedule", args, () => {
            const current = this.readReminder(args.reminderId)!;
            if (current.version !== args.expectedVersion || current.state !== "active")
              throw new AgentToolRefusal("Reminder version or state changed");
            this.db
              .prepare(
                "UPDATE owner_reminders SET due_at=?,version=version+1,updated_at=? WHERE id=?",
              )
              .run(args.dueAt, this.now(), current.id);
            return this.readReminder(current.id)!;
          });
        },
      ),

      "reminders.cancel": defineConversationTool(
        conversationToolDefinitions["reminders.cancel"],
        (run, toolCallId, args) => {
          const reminder = this.readReminder(args.reminderId);
          if (!reminder || reminder.agentId !== run.agent_id)
            throw new AgentToolRefusal("Reminder is not available");
          return this.toolActions.record(run, toolCallId, "reminders.cancel", args, () => {
            const current = this.readReminder(args.reminderId)!;
            if (current.version !== args.expectedVersion || current.state !== "active")
              throw new AgentToolRefusal("Reminder version or state changed");
            this.db
              .prepare(
                "UPDATE owner_reminders SET state='cancelled',version=version+1,updated_at=? WHERE id=?",
              )
              .run(this.now(), current.id);
            return this.readReminder(current.id)!;
          });
        },
      ),

      "reminders.list": defineConversationTool(
        conversationToolDefinitions["reminders.list"],
        (run, toolCallId, args) => {
          this.syncHandledReminders();
          return { reminders: this.listAgentReminders(run.agent_id) };
        },
      ),
    };
  }
}
