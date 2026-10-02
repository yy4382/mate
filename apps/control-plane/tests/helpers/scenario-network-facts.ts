import Database from "better-sqlite3";
import { join } from "node:path";
import { z } from "zod";

const reminderSchema = z.object({
  id: z.string(),
  state: z.enum(["active", "fired", "cancelled"]),
  text: z.string(),
  deliveryId: z.string().nullable(),
  deliveryState: z.enum(["pending", "handled"]).nullable(),
});

/** Only durable queue facts missing from the Owner API; never mutates the business database. */
export function readNetworkQueueFacts(directory: string, agentId: string) {
  const db = new Database(join(directory, "control-plane-data", "control-plane.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return {
      reminders: reminderSchema.array().parse(
        db
          .prepare(
            `SELECT r.id,r.state,r.text,
        f.delivery_id AS deliveryId,d.state AS deliveryState FROM owner_reminders r
        LEFT JOIN owner_reminder_firings f ON f.reminder_id=r.id
        LEFT JOIN owner_message_deliveries d ON d.id=f.delivery_id
        WHERE r.agent_id=? ORDER BY r.id`,
          )
          .all(agentId),
      ),
      deliveries: z
        .object({ id: z.string(), messageId: z.string(), state: z.enum(["pending", "handled"]) })
        .array()
        .parse(
          db
            .prepare(
              "SELECT id,message_id AS messageId,state FROM owner_message_deliveries WHERE recipient_kind='agent' AND recipient_id=? ORDER BY seq",
            )
            .all(agentId),
        ),
      running: z
        .object({ id: z.string() })
        .array()
        .parse(
          db
            .prepare("SELECT id FROM owner_agent_runs WHERE agent_id=? AND state='running'")
            .all(agentId),
        ),
    };
  } finally {
    db.close();
  }
}
