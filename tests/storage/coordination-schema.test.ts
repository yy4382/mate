import { afterEach, expect, it } from "vitest";
import { Store, encode } from "../../src/storage/store.js";
import { migrateCanonicalConversations } from "../../src/slack/canonical-migration.js";
import { migrateInternalConversations } from "../../src/storage/internal-schema.js";
import { migrateProjections } from "../../src/storage/projection-schema.js";
import { migrateProjectionImports } from "../../src/storage/projection-import-schema.js";
import { migrateHistoryIndexes } from "../../src/storage/history-schema.js";
import { migrateCoordinationRecovery } from "../../src/storage/coordination-schema.js";
import { configFixture } from "../helpers/config.js";
import { slackApplication } from "../../src/slack/application.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
it("backs v21 tasks only from durable creator evidence and marks prior history incomplete", () => {
  const store = new Store(":memory:");
  stores.push(store);
  store.register("research", "v1", []);
  store.register("peer", "v1", []);
  migrateCanonicalConversations(store, configFixture);
  migrateInternalConversations(store);
  migrateProjections(store);
  migrateProjectionImports(store);
  migrateHistoryIndexes(store);
  const { messages } = slackApplication(store, configFixture);
  messages.references.createConversation("channel", "external", "CTEST");
  messages.references.bindConversation(
    { provider: "slack", workspace: "TTEST", externalId: "CTEST" },
    "CTEST",
    "primary",
  );
  messages.references.createMessage("CTEST", "bound-message");
  messages.membership("research", "CTEST", true);
  messages.record(
    {
      id: "bound-message",
      conversationId: "CTEST",
      rootId: "bound-message",
      author: { kind: "human", id: "owner" },
      origin: "participant",
      mentions: [],
      text: "bound",
      deleted: false,
      order: "1",
      revision: "1",
      attachments: [],
    },
    ["research"],
  );
  store.db
    .prepare(
      "INSERT INTO works(id,origin,target,max_runs,max_tokens,max_cost) VALUES('w','old',?,1,1,1)",
    )
    .run(encode({ conversationId: "CTEST" }));
  store.db
    .prepare(
      "INSERT INTO tasks(id,work_id,target,title,status,version) VALUES('proved','w',?,'proved','todo',3),('unknown','w',?,'unknown','todo',7)",
    )
    .run(encode({ conversationId: "CTEST" }), encode({ conversationId: "CTEST" }));
  store.db
    .prepare(
      "INSERT INTO tasks(id,work_id,target,title,status,version,message_key) VALUES('bound','w',?,'bound','todo',2,'bound-message')",
    )
    .run(encode({ conversationId: "CTEST" }));
  store.db
    .prepare("INSERT INTO task_events(task_id,at,body) VALUES(?,?,?)")
    .run("proved", 1, encode({ action: "create", agentId: "research" }));
  store.db
    .prepare("INSERT INTO task_events(task_id,at,body) VALUES(?,?,?),(?,?,?)")
    .run(
      "unknown",
      2,
      encode({ action: "create", agentId: "research" }),
      "unknown",
      3,
      encode({ action: "create", agentId: "peer" }),
    );
  store.db
    .prepare(
      "INSERT INTO schedules(id,agent_id,work_id,target,next_at,timezone,content,legacy) VALUES('old-reminder','research','w',?,100,'UTC','old',0)",
    )
    .run(encode({ conversationId: "CTEST" }));
  migrateCoordinationRecovery(store);
  migrateCoordinationRecovery(store);
  expect(store.db.pragma("user_version", { simple: true })).toBe(22);
  expect(store.db.prepare("SELECT id,created_by,legacy FROM tasks ORDER BY id").all()).toEqual([
    { id: "bound", created_by: null, legacy: 0 },
    { id: "proved", created_by: "research", legacy: 1 },
    { id: "unknown", created_by: null, legacy: 1 },
  ]);
  expect(
    store.db
      .prepare(
        "SELECT task_id,complete_after_version,historical_complete FROM task_event_baselines ORDER BY task_id",
      )
      .all(),
  ).toEqual([
    { task_id: "bound", complete_after_version: 2, historical_complete: 0 },
    { task_id: "proved", complete_after_version: 3, historical_complete: 0 },
    { task_id: "unknown", complete_after_version: 7, historical_complete: 0 },
  ]);
  expect(
    JSON.parse(
      (
        store.db
          .prepare("SELECT body FROM task_events WHERE task_id='unknown' ORDER BY id DESC LIMIT 1")
          .get() as { body: string }
      ).body,
    ),
  ).toMatchObject({
    action: "migration_snapshot",
    historicalComplete: false,
    createdByEvidence: "conflicting_create_events",
  });
  expect(
    store.db.prepare("SELECT projection FROM schedules WHERE id='old-reminder'").get(),
  ).toEqual({ projection: "conversation_receipt" });
});
