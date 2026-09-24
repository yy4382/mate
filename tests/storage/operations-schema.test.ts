import { afterEach, expect, it } from "vitest";
import { Store } from "../../src/storage/store.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
function store() {
  const s = new Store(":memory:");
  stores.push(s);
  s.db.prepare("INSERT INTO conversation_identities VALUES('room','channel','internal')").run();
  return s;
}

it("timestamps only new effects and supports bounded activity indexes", () => {
  const s = store();
  s.register("agent", "v1", []);
  s.enqueue("agent", "new", {});
  const run = s.beginRun("agent")!;
  s.input(run, {});
  s.prepareAction(run, "new-action", {});
  s.queueOutput(
    "agent",
    "new-output",
    { target: { conversationId: "room" } },
    JSON.stringify({ conversationId: "room" }),
  );
  expect(
    s.db.prepare("SELECT created_at IS NOT NULL present FROM actions WHERE id='new-action'").get(),
  ).toEqual({ present: 1 });
  expect(
    s.db.prepare("SELECT created_at IS NOT NULL present FROM outbox WHERE id='new-output'").get(),
  ).toEqual({ present: 1 });
  const plans = [
    s.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT e.at,e.id FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE (e.at<? OR (e.at=? AND e.id<?)) AND COALESCE(json_extract(e.body,'$.actor'),json_extract(e.body,'$.agentId'))=? AND 'task.'||json_extract(e.body,'$.action') IN (?) ORDER BY e.at DESC,e.id DESC LIMIT ?",
      )
      .all(10, 10, 10, "agent", "task.done", 51),
    s.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT e.at,e.seq FROM reminder_events e JOIN schedules r ON r.id=e.reminder_id WHERE e.actor_id=? AND e.kind IN (?) ORDER BY e.at DESC,e.seq DESC LIMIT ?",
      )
      .all("agent", "edited", 51),
    s.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT f.due_at,f.id FROM reminder_firings f JOIN schedules r ON r.id=f.reminder_id JOIN deliveries d ON d.id=f.delivery_id WHERE f.actor_id=? ORDER BY f.due_at DESC,f.id DESC LIMIT ?",
      )
      .all("agent", 51),
    s.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT r.created_at,r.id FROM runs r LEFT JOIN run_context rc ON rc.run_id=r.id WHERE r.agent_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT ?",
      )
      .all("agent", 51),
    s.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT a.created_at,a.id FROM actions a WHERE a.agent_id=? AND a.created_at IS NOT NULL ORDER BY a.created_at DESC,a.id DESC LIMIT ?",
      )
      .all("agent", 51),
    s.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT o.created_at,o.id FROM outbox o LEFT JOIN output_work ow ON ow.output_id=o.id WHERE o.agent_id=? AND o.created_at IS NOT NULL ORDER BY o.created_at DESC,o.id DESC LIMIT ?",
      )
      .all("agent", 51),
    s.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT f.at,f.seq FROM operational_facts f WHERE (f.at<? OR (f.at=? AND f.seq<?)) AND f.actor_id=? AND f.kind IN (?) AND f.source=? ORDER BY f.at DESC,f.seq DESC LIMIT ?",
      )
      .all(10, 10, 10, "agent", "run_completed", "runtime", 51),
    s.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM actions WHERE state IN ('executing','unknown') ORDER BY id DESC LIMIT ?",
      )
      .all(101),
    s.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM outbox WHERE state='unknown' ORDER BY id DESC LIMIT ?",
      )
      .all(101),
    s.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT d.id FROM outbox o INDEXED BY output_held_status JOIN drafts d INDEXED BY draft_output_lookup ON d.outbox_id=o.id WHERE o.state='held' ORDER BY o.id DESC LIMIT ?",
      )
      .all(101),
    s.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM schedules WHERE active=1 AND next_at<=? ORDER BY next_at,id LIMIT ?",
      )
      .all(Date.now(), 101),
    s.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM task_event_baselines WHERE historical_complete=0",
      )
      .all(),
    s.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM reminder_event_baselines WHERE historical_complete=0",
      )
      .all(),
    s.db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM actions WHERE created_at IS NULL").all(),
  ].flat() as { detail: string }[];
  const details = plans.map((row) => row.detail).join("\n");
  expect(details).not.toContain("USE TEMP B-TREE");
  for (const index of [
    "task_activity_actor_kind",
    "reminder_activity_actor_kind",
    "reminder_firing_activity_actor",
    "run_activity_actor",
    "action_activity_actor",
    "output_activity_actor",
    "operational_fact_actor_kind_activity",
    "action_uncertain_status",
    "output_unknown_status",
    "output_held_status",
    "schedule_due_status",
    "task_baseline_gaps",
    "reminder_baseline_gaps",
    "action_missing_activity_time",
  ])
    expect(details).toContain(index);
});

it("rejects facts outside the narrow source-specific privacy contract", () => {
  const s = store();
  s.register("agent", "v1", []);
  expect(() =>
    s.atomic(() =>
      s.db
        .prepare(
          "INSERT INTO operational_facts(at,source,source_id,kind,actor_id,subject_type,subject_id,counts) VALUES(1,'runtime','bad','internal_dm_created','agent','internal_dm','dm','{\"members\":2}')",
        )
        .run(),
    ),
  ).toThrow();
  expect(() =>
    s.atomic(() =>
      s.db
        .prepare(
          "INSERT INTO operational_facts(at,source,source_id,kind,actor_id,subject_type,subject_id,counts) VALUES(1,'internal_dm','bad','internal_dm_created','agent','internal_dm','dm','{\"members\":2,\"private\":1}')",
        )
        .run(),
    ),
  ).toThrow();
});
