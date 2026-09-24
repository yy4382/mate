import { afterEach, expect, it } from "vitest";
import { Store, encode } from "../../src/storage/store.js";
import { References } from "../../src/conversations/references.js";
import { CanonicalWrites } from "../../src/storage/conversation-writes.js";
import { MessageIngestion } from "../../src/conversations/ingestion.js";
import { ConfiguredAgents } from "../../src/agents/directory.js";
import { Messages } from "../fixtures/v16/src/slack/messages.js";
import { slackConversationStorage } from "../fixtures/v16/src/slack/conversation-storage.js";
import { migrateCanonicalConversations } from "../../src/slack/canonical-migration.js";
import { configFixture } from "../helpers/config.js";
import type { MessageDTO } from "../../src/domain/messages.js";
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function setup() {
  const s = new Store(":memory:");
  stores.push(s);
  s.register("research", "legacy", []);
  const refs = new References(s),
    records = slackConversationStorage(s, configFixture).records,
    writes = new CanonicalWrites(s, refs);
  const ingestion = new MessageIngestion(
    s,
    refs,
    records,
    writes,
    new ConfiguredAgents(configFixture.agents),
    { participates: () => true },
  );
  return { s, refs, records, writes, ingestion };
}
function message(): MessageDTO {
  return {
    id: "a-message",
    conversationId: "a-space",
    rootId: "a-message",
    author: { kind: "human", id: "person" },
    origin: "participant",
    mentions: [],
    text: "work",
    deleted: false,
    order: "9",
    revision: "9",
    attachments: [],
  };
}

it("ingests non-platform IDs with structured identity and numeric revision ordering", () => {
  const { s, refs, records, ingestion } = setup();
  migrateCanonicalConversations(s, configFixture);
  refs.createConversation("dm", "external", "a-space");
  s.db.prepare("INSERT INTO channel_access VALUES(?,?,1)").run("research", "a-space");
  ingestion.record(message(), ["research"]);
  ingestion.record({ ...message(), revision: "10", text: "changed" }, ["research"]);
  ingestion.record(message(), ["research"]);
  expect(records.message("a-message")).toMatchObject({
    text: "changed",
    revision: "10",
  });
  expect(s.db.prepare("SELECT count(*) n FROM deliveries").get()).toEqual({
    n: 2,
  });
  expect(s.db.prepare("SELECT count(*) n FROM conversation_events").get()).toEqual({ n: 2 });
  expect(() => ingestion.record({ ...message(), order: "11" }, ["research"])).toThrow("immutable");
});

it("preserves delivery identity/status when a migrated observation is replayed", () => {
  for (const status of ["pending", "injected", "handled"]) {
    const { s, records, ingestion } = setup(),
      legacy = new Messages(s, configFixture);
    legacy.membership("research", "CTEST", true);
    legacy.record(
      {
        team: "TTEST",
        channel: "CTEST",
        ts: "1.000001",
        thread: "1.000001",
        revision: "1.000001",
        text: "<@UONE> work",
        user: "UOWNER",
        deleted: false,
      },
      ["research"],
    );
    s.db.prepare("UPDATE deliveries SET status=?").run(status);
    const before = s.db.prepare("SELECT id,dedupe,status FROM deliveries").all();
    migrateCanonicalConversations(s, configFixture);
    ingestion.record(records.message(encode(["TTEST", "CTEST", "1.000001"]))!, ["research"]);
    expect(s.db.prepare("SELECT id,dedupe,status FROM deliveries").all()).toEqual(before);
  }
});

it("enriches a deleted unknown root without reviving content or creating a wakeup", () => {
  const { s, refs, records, ingestion } = setup();
  migrateCanonicalConversations(s, configFixture);
  refs.createConversation("dm", "external", "a-space");
  s.db.prepare("INSERT INTO channel_access VALUES(?,?,1)").run("research", "a-space");
  ingestion.record({ ...message(), rootId: null, revision: "10", deleted: true, text: "" }, [
    "research",
  ]);
  ingestion.record({ ...message(), rootId: "known-root" }, ["research"]);
  expect(records.message("a-message")).toMatchObject({
    rootId: "known-root",
    revision: "10",
    deleted: true,
    text: "",
  });
  expect(s.db.prepare("SELECT count(*) n FROM deliveries").get()).toEqual({
    n: 0,
  });
});
