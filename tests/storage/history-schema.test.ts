import { afterEach, expect, it } from "vitest";
import { Store } from "../../src/storage/store.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));
it("bounds canonical conversation and thread history with dedicated current-format indexes", () => {
  const store = new Store(":memory:");
  stores.push(store);
  expect(
    store.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'message_history_%' ORDER BY name",
      )
      .all(),
  ).toEqual([{ name: "message_history_conversation" }, { name: "message_history_thread" }]);
  const conversation = store.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT key,channel,ts FROM messages WHERE channel=? AND deleted=0 ORDER BY length(ts) DESC,ts DESC,key DESC LIMIT 1001",
    )
    .all("room") as { detail: string }[];
  const thread = store.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT key FROM messages WHERE channel=? AND thread=? AND deleted=0 ORDER BY length(ts) DESC,ts DESC,key DESC LIMIT 51",
    )
    .all("room", "root") as { detail: string }[];
  const production = store.db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT m.key,m.channel,m.ts FROM messages m INDEXED BY message_history_conversation
    JOIN conversation_identities c ON c.id=m.channel JOIN channel_access a ON a.channel=m.channel
    LEFT JOIN message_visibility v ON v.key=m.key AND v.agent_id=a.agent_id
    WHERE a.agent_id=? AND a.active=1 AND ((c.authority='internal' AND c.kind='channel') OR v.key IS NOT NULL) AND m.channel=?
    ORDER BY m.channel,length(m.ts) DESC,m.ts DESC,m.key DESC LIMIT 1001`,
    )
    .all("agent", "room") as { detail: string }[];
  const productionThread = store.db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT m.key,m.channel,m.ts FROM messages m INDEXED BY message_history_thread
    JOIN conversation_identities c ON c.id=m.channel JOIN channel_access a ON a.channel=m.channel
    LEFT JOIN message_visibility v ON v.key=m.key AND v.agent_id=a.agent_id
    WHERE a.agent_id=? AND a.active=1 AND ((c.authority='internal' AND c.kind='channel') OR v.key IS NOT NULL) AND m.channel=? AND m.thread=?
    ORDER BY m.channel,length(m.ts) DESC,m.ts DESC,m.key DESC LIMIT 1001`,
    )
    .all("agent", "room", "root") as { detail: string }[];
  const globalChannels = store.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT channel FROM channel_access WHERE agent_id=? AND active=1 AND (? IS NULL OR channel>=?) ORDER BY channel",
    )
    .all("agent", null, null) as { detail: string }[];
  const globalSegment = store.db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT m.key,m.channel,m.ts FROM messages m INDEXED BY message_history_conversation
    JOIN conversation_identities c ON c.id=m.channel LEFT JOIN message_visibility v ON v.key=m.key AND v.agent_id=?
    WHERE m.channel=? AND ((c.authority='internal' AND c.kind='channel') OR v.key IS NOT NULL)
    ORDER BY m.channel,length(m.ts) DESC,m.ts DESC,m.key DESC LIMIT ?`,
    )
    .all("agent", "room", 1001) as { detail: string }[];
  const snapshotSearch = store.db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT m.key FROM messages m INDEXED BY message_history_conversation
    JOIN conversation_identities c ON c.id=m.channel JOIN message_visibility v ON v.key=m.key AND v.agent_id=?
    WHERE m.channel=? AND ((c.authority='external' AND json_extract(v.body,'$.message.deleted')=0 AND instr(lower(json_extract(v.body,'$.message.text')),lower(?))>0)
      OR (c.authority='internal' AND m.deleted=0 AND instr(lower(json_extract(m.body,'$.message.text')),lower(?))>0))
    ORDER BY length(m.ts) DESC,m.ts DESC,m.key DESC LIMIT ?`,
    )
    .all("agent", "room", "needle", "needle", 100) as { detail: string }[];
  expect(conversation.some((row) => row.detail.includes("message_history_conversation"))).toBe(
    true,
  );
  expect(thread.some((row) => row.detail.includes("message_history_thread"))).toBe(true);
  expect(production.some((row) => row.detail.includes("message_history_conversation"))).toBe(true);
  expect(productionThread.some((row) => row.detail.includes("message_history_thread"))).toBe(true);
  expect(globalSegment.some((row) => row.detail.includes("message_history_conversation"))).toBe(
    true,
  );
  expect(snapshotSearch.some((row) => row.detail.includes("message_history_conversation"))).toBe(
    true,
  );
  expect(
    [
      ...conversation,
      ...thread,
      ...production,
      ...productionThread,
      ...globalChannels,
      ...globalSegment,
      ...snapshotSearch,
    ].some((row) => row.detail.includes("SCAN m") || row.detail.includes("USE TEMP B-TREE")),
  ).toBe(false);
});
