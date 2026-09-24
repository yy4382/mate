import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Store } from "../../src/storage/store.js";
import { configFixture } from "../helpers/config.js";
import { configSchema } from "../../src/config.js";
import { DurableReceiver } from "../../src/slack/receiver.js";
import { Messages, Output } from "../helpers/canonical-slack.js";
import type { NormalMessage } from "../fixtures/v16/src/slack/messages.js";
const stores: Store[] = [];
function setup() {
  const config = configSchema.parse({
    ...configFixture,
    agents: [
      configFixture.agents[0],
      {
        ...configFixture.agents[0],
        id: "engineer",
        name: "Engineer",
        slackAppId: "ATWO",
        slackUserId: "UTWO",
        slackBotId: "BTWO",
        botTokenEnv: "ENGINEER_BOT",
        appTokenEnv: "ENGINEER_APP",
      },
    ],
  });
  const db = new Store(":memory:");
  stores.push(db);
  config.agents.forEach((a) => db.register(a.id, "v1", []));
  const messages = new Messages(db, config);
  config.agents.forEach((a) => messages.membership(a.id, "CTEST", true));
  const msg: NormalMessage = {
    team: "TTEST",
    channel: "CTEST",
    ts: "100.000001",
    thread: "100.000001",
    revision: "100.000001",
    text: "<@UONE> <@UTWO> synthetic",
    user: "UOWNER",
    deleted: false,
  };
  new Output(messages, { post: async () => ({ ts: "999.000001" }) });
  return { db, messages, msg };
}
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
});
it("commits before ack, retries dedupe, database failure does not ack", async () => {
  const { db } = setup();
  const socket = Object.assign(new EventEmitter(), {
    start: async () => {},
    disconnect: async () => {},
  });
  const receiver = new DurableReceiver(db, "AONE", "TTEST", socket, () => {});
  const ack = vi.fn(async () => {
    expect(db.db.prepare("SELECT count(*) n FROM ingress").get()).toEqual({ n: 1 });
  });
  const envelope = {
    envelope_id: "env",
    body: { team_id: "TTEST", api_app_id: "AONE", event_id: "evt" },
    ack,
  };
  await receiver.receive(envelope);
  await receiver.receive(envelope);
  expect(ack).toHaveBeenCalledTimes(2);
  db.db.exec(
    "CREATE TRIGGER fail_ingress BEFORE INSERT ON ingress BEGIN SELECT RAISE(ABORT,'disk full'); END;",
  );
  await expect(
    receiver.receive({ ...envelope, envelope_id: "new", body: { event_id: "new" } }),
  ).rejects.toThrow();
  expect(ack).toHaveBeenCalledTimes(2);
});
it("multi-app observations deliver once per visible Agent, old revision cannot resurrect deletion", () => {
  const { db, messages, msg } = setup();
  messages.record(msg, ["research"]);
  messages.record(msg, ["research", "engineer"]);
  expect(db.db.prepare("SELECT count(*) n FROM deliveries").get()).toEqual({ n: 2 });
  messages.record({ ...msg, revision: "101.000001", text: "edited" }, ["research"]);
  messages.record({ ...msg, revision: "102.000001", deleted: true }, ["research"]);
  messages.record(msg, ["engineer"]);
  expect(messages.search("engineer", "synthetic")).toEqual([]);
});
it("normalizes edits/deletes and isolated DM without app_mention", () => {
  const { db, messages } = setup();
  const ingest = (id: string, event: unknown) => {
    db.ingest("AONE", id, { team_id: "TTEST", event });
    messages.normalize("AONE", id);
  };
  ingest("dm", {
    type: "message",
    channel: "DPRIVATE",
    ts: "100.000001",
    user: "UOWNER",
    text: "original",
  });
  expect(messages.recent("research", messages.mapper.conversation("DPRIVATE"))[0]?.text).toBe(
    "original",
  );
  expect(() => messages.recent("engineer", messages.mapper.conversation("DPRIVATE"))).toThrow(
    "access denied",
  );
  ingest("edit", {
    type: "message",
    subtype: "message_changed",
    channel: "DPRIVATE",
    event_ts: "102.000001",
    message: { ts: "100.000001", edited: { ts: "101.000001" }, user: "UOWNER", text: "edited" },
  });
  expect(messages.recent("research", messages.mapper.conversation("DPRIVATE"))[0]?.text).toBe(
    "edited",
  );
  ingest("delete", {
    type: "message",
    subtype: "message_deleted",
    channel: "DPRIVATE",
    event_ts: "103.000001",
    deleted_ts: "100.000001",
  });
  expect(messages.recent("research", messages.mapper.conversation("DPRIVATE"))).toEqual([]);
});
it("cached reads and queued sends obey current membership", async () => {
  const { messages, msg, db } = setup();
  messages.record(msg, ["research"]);
  expect(messages.search("research", "synthetic")).toHaveLength(1);
  expect(messages.search("engineer", "synthetic")).toEqual([]);
  const post = vi.fn(async () => ({ ts: "103.000001" }));
  const output = new Output(messages, { post });
  const id = output.queue(
    "research",
    { conversationId: "CTEST", threadId: messages.mapper.messageId("CTEST", msg.ts) },
    "reply",
  );
  messages.membership("research", "CTEST", false);
  expect(messages.search("research", "synthetic")).toEqual([]);
  expect(() =>
    messages.read("research", {
      conversationId: "CTEST",
      threadId: messages.mapper.messageId("CTEST", msg.ts),
    }),
  ).toThrow("access denied");
  await output.send(id);
  expect(post).not.toHaveBeenCalled();
  expect(db.output(id)?.state).toBe("failed");
});
it("background participation coalesces until window end, while explicit mentions remain prompt", () => {
  const { messages, db, msg } = setup();
  messages.mapper.config.agents[0]!.channels.CTEST = "participate";
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    messages.record({ ...msg, text: "background one" }, ["research"]);
    messages.record({ ...msg, ts: "100.000002", revision: "100.000002", text: "background two" }, [
      "research",
    ]);
    expect(db.db.prepare("SELECT count(*) n FROM deliveries").get()).toEqual({ n: 1 });
    expect(messages.recent("research", "CTEST")).toHaveLength(2);
    expect(db.beginRun("research", 19999)).toBeUndefined();
    expect(db.beginRun("research", 20000)).toBeDefined();
    clock.mockReturnValue(21000);
    messages.record({ ...msg, text: "background one" }, ["research"]);
    expect(db.db.prepare("SELECT count(*) n FROM deliveries").get()).toEqual({ n: 1 });
  } finally {
    clock.mockRestore();
  }
});
it("send receipt directly wakes peer, echo and event_ts do not duplicate, self remains quiet", async () => {
  const { messages, db, msg } = setup();
  const output = new Output(messages, { post: async () => ({ ts: "103.000001" }) });
  const id = output.queue(
    "research",
    { conversationId: "CTEST", threadId: messages.mapper.messageId("CTEST", msg.ts) },
    "<@UTWO> verify this",
  );
  await output.send(id);
  expect(db.output(id)?.state).toBe("sent");
  const event = {
    team_id: "TTEST",
    event: {
      type: "message",
      channel: "CTEST",
      ts: "103.000001",
      thread_ts: msg.ts,
      event_ts: "104.000001",
      text: "<@UTWO> verify this",
      bot_id: "BONE",
      user: "UONE",
    },
  };
  db.ingest("ATWO", "echo", event);
  messages.normalize("ATWO", "echo");
  expect(db.db.prepare("SELECT agent_id FROM deliveries").all()).toEqual([
    { agent_id: "engineer" },
  ]);
});
it("network uncertainty never retries; 429 waits until Retry-After and sends once", async () => {
  const { messages, db, msg } = setup();
  const target = { conversationId: "CTEST", threadId: messages.mapper.messageId("CTEST", msg.ts) };
  let now = 1000;
  const post = vi
    .fn()
    .mockRejectedValueOnce(new Error("connection lost"))
    .mockImplementationOnce(async () => {
      now = 11000;
      throw { code: "slack_webapi_rate_limited_error", retryAfter: 3 };
    })
    .mockResolvedValue({ ts: "200.000001" });
  const output = new Output(messages, { post }, () => now);
  const first = output.queue("research", target, "one");
  await output.send(first);
  await output.send(first);
  expect(post).toHaveBeenCalledTimes(1);
  expect(db.output(first)?.state).toBe("unknown");
  expect(() =>
    output.confirm(first, db.output(first)!.request_hash, {
      message: messages.mapper.message({
        ts: "150.000001",
        revision: "150.000001",
        user: "UTWO",
        channel: "CTEST",
        thread: msg.ts,
        text: "one",
        deleted: false,
      }),
      receipt: { ts: "150.000001" },
    }),
  ).toThrow("mismatch");
  output.confirm(first, db.output(first)!.request_hash, {
    message: messages.mapper.message({
      ts: "150.000001",
      revision: "150.000001",
      user: "UONE",
      channel: "CTEST",
      thread: msg.ts,
      text: "one",
      deleted: false,
    }),
    receipt: { ts: "150.000001" },
  });
  expect(db.output(first)?.state).toBe("sent");
  const second = output.queue("research", target, "two");
  await output.send(second);
  now = 13999;
  await output.send(second);
  expect(post).toHaveBeenCalledTimes(2);
  now = 14000;
  await output.send(second);
  expect(post).toHaveBeenCalledTimes(3);
});
it("Slack internal_error can have partially succeeded and stays reconcilable", async () => {
  const { messages, db, msg } = setup();
  const output = new Output(messages, {
    post: async () => {
      throw { code: "slack_webapi_platform_error", data: { error: "internal_error" } };
    },
  });
  const id = output.queue(
    "research",
    { conversationId: "CTEST", threadId: messages.mapper.messageId("CTEST", msg.ts) },
    "https://example.com",
  );
  await output.send(id);
  expect(db.output(id)?.state).toBe("unknown");
  output.confirm(id, db.output(id)!.request_hash, {
    message: messages.mapper.message({
      ts: "120.000001",
      revision: "120.000001",
      user: "UONE",
      channel: "CTEST",
      thread: msg.ts,
      text: "<https://example.com>",
      deleted: false,
    }),
    receipt: { ts: "120.000001" },
  });
  expect(db.output(id)?.state).toBe("sent");
});
