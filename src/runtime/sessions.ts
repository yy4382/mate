import type { AgentDefinition } from "../domain/agents.js";
import type { Collaboration } from "../collaboration/service.js";
import type { RunToken } from "../storage/store.js";
import { z } from "zod";
interface Reset {
  id: string;
  agent_id: string;
  source_session: string;
  work_id: string;
  delivery_id: string;
  checkpoint: string;
  state: string;
  new_session: string | null;
}
export class SessionLifecycle {
  constructor(
    readonly c: Collaboration,
    readonly baseline: (agent: AgentDefinition) => { configVersion: string; messages: unknown[] },
  ) {}
  checkpoint(actor: string, text: string): unknown {
    z.string().min(1).max(20000).parse(text);
    this.c.agents.get(actor);
    this.c.store.db
      .prepare(
        "INSERT INTO agent_checkpoints VALUES(?,?,1,?) ON CONFLICT(agent_id) DO UPDATE SET text=excluded.text,version=agent_checkpoints.version+1,updated_at=excluded.updated_at",
      )
      .run(actor, text, Date.now());
    return this.status(actor);
  }
  status(actor: string): unknown {
    this.c.agents.get(actor);
    return {
      agentId: actor,
      session: (
        this.c.store.db.prepare("SELECT session_id FROM agents WHERE id=?").get(actor) as {
          session_id: string;
        }
      ).session_id,
      checkpoint:
        this.c.store.db
          .prepare("SELECT text,version,updated_at FROM agent_checkpoints WHERE agent_id=?")
          .get(actor) ?? null,
      pending:
        this.c.store.db
          .prepare(
            "SELECT id,source_session,state FROM session_resets WHERE agent_id=? AND state='requested'",
          )
          .get(actor) ?? null,
    };
  }
  request(run: RunToken, workId: string, id: string, text: string): unknown {
    const s = this.c.store;
    s.assertRun(run);
    this.c.assertActionWork(run, workId);
    this.checkpoint(run.agentId, text);
    s.db
      .prepare(
        "INSERT INTO session_resets(id,agent_id,source_session,work_id,delivery_id,checkpoint,state) VALUES(?,?,?,?,?,?,'requested')",
      )
      .run(id, run.agentId, run.sessionId, workId, run.deliveryId, text);
    return { resetId: id, status: "requested", appliesAfterRun: true };
  }
  apply(actor: string): boolean {
    const s = this.c.store;
    return s.atomic(() => {
      const request = s.db
        .prepare("SELECT * FROM session_resets WHERE agent_id=? AND state='requested'")
        .get(actor) as Reset | undefined;
      if (!request) return false;
      if (s.db.prepare("SELECT 1 FROM runs WHERE agent_id=? AND state='active'").get(actor))
        return false;
      const current = (
        s.db.prepare("SELECT session_id FROM agents WHERE id=?").get(actor) as {
          session_id: string;
        }
      ).session_id;
      if (current !== request.source_session) {
        s.db.prepare("UPDATE session_resets SET state='superseded' WHERE id=?").run(request.id);
        return false;
      }
      const baseline = this.baseline(this.c.agents.get(actor));
      const next = s.rotateSession(
        actor,
        baseline.configVersion,
        [
          ...baseline.messages,
          {
            role: "user",
            content: `Private checkpoint authored by this Agent before replacing its context. Preserve the user's ongoing objective; inspect tasks, reminders, drafts and unknown receipts as needed.\n${request.checkpoint}`,
            timestamp: 0,
          },
        ],
        "agent_requested",
      );
      s.db
        .prepare("UPDATE session_resets SET state='applied',new_session=? WHERE id=?")
        .run(next, request.id);
      s.db.prepare("UPDATE deliveries SET status='handled' WHERE id=?").run(request.delivery_id);
      if (this.c.work(request.work_id).state !== "cancelled") {
        const delivery = this.c.messages.writes.enqueue(actor, `session-reset:${request.id}`, {
          kind: "session_continuation",
          checkpointId: request.id,
          priorDeliveryId: request.delivery_id,
          target: JSON.parse(this.c.work(request.work_id).target),
        });
        this.c.bindDelivery(delivery, request.work_id);
      }
      return true;
    });
  }
  resetStopped(actor: string, text: string): string {
    const s = this.c.store;
    return s.atomic(() => {
      this.checkpoint(actor, text);
      const baseline = this.baseline(this.c.agents.get(actor));
      const id = s.rotateSession(
        actor,
        baseline.configVersion,
        [
          ...baseline.messages,
          { role: "user", content: `Owner-provided context checkpoint:\n${text}`, timestamp: 0 },
        ],
        "owner_requested",
      );
      s.db
        .prepare(
          "UPDATE session_resets SET state='superseded' WHERE agent_id=? AND state='requested'",
        )
        .run(actor);
      return id;
    });
  }
}
