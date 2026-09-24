import { slackTextMatches } from "../../src/slack/text.js";
import { afterEach, expect, it, vi } from "vitest";
import { Store, encode } from "../../src/storage/store.js";
import { Messages as LegacyMessages } from "../fixtures/v16/src/slack/messages.js";
import { migrateCanonicalConversations } from "../../src/slack/canonical-migration.js";
import { slackApplication } from "../../src/slack/application.js";
import { CanonicalOutput } from "../../src/conversations/output.js";
import { CanonicalAttention } from "../../src/conversations/attention.js";
import { CanonicalFreshnessGate } from "../../src/conversations/freshness.js";
import { CanonicalSlackTransport } from "../../src/slack/transport.js";
import { CanonicalSlackNormalizer } from "../../src/slack/normalize.js";
import { configFixture } from "../helpers/config.js";
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
function setup(
  unknownTarget: { channel: string; thread?: string } = {
    channel: "CTEST",
    thread: "1.000001",
  },
) {
  const s = new Store(":memory:");
  stores.push(s);
  s.register("research", "test", []);
  const old = new LegacyMessages(s, configFixture);
  old.membership("research", "CTEST", true);
  for (const ts of ["1.000001", "2.000001"])
    old.record(
      {
        team: "TTEST",
        channel: "CTEST",
        ts,
        thread: ts,
        revision: ts,
        text: "root",
        user: "UOWNER",
        deleted: false,
      },
      ["research"],
    );
  s.queueOutput("research", "old", {
    target: unknownTarget,
    text: "legacy reply",
  });
  s.transitionOutput("old", "pending", "sending");
  s.transitionOutput("old", "sending", "unknown", { reason: "uncertain" });
  const original = s.output("old")!;
  migrateCanonicalConversations(s, configFixture);
  const app = slackApplication(s, configFixture),
    transport = new CanonicalSlackTransport(s, app.mapper, {}),
    post = vi.fn(async () => ({ ts: "10.000001" }));
  transport.clients.set("research", { chat: { postMessage: post } } as any);
  const output = new CanonicalOutput(app.messages, transport),
    gate = new CanonicalFreshnessGate(app.messages, new CanonicalAttention(app.messages));
  output.gate = gate;
  s.enqueue("research", "start", {});
  const run = s.beginRun("research")!;
  s.input(run, {});
  const target = (ts?: string) => ({
    conversationId: app.mapper.conversation("CTEST"),
    ...(ts ? { threadId: app.mapper.messageId("CTEST", ts) } : {}),
  });
  const queue = (id: string, ts?: string) => {
    output.queue("research", target(ts), id, id, { run });
    const draft = gate.describe("research", id) as {
      revision: number;
      holdId: string;
    };
    gate.continueOnce(run, id, draft.revision, draft.holdId);
  };
  return {
    s,
    ...app,
    transport,
    post,
    output,
    gate,
    run,
    target,
    queue,
    original,
  };
}
it("old unknown and new canonical sends share precise blocking scopes without mirrored indexes", async () => {
  const f = setup();
  expect(
    f.s.db.prepare("SELECT 1 FROM sqlite_master WHERE name='canonical_targets'").get(),
  ).toBeUndefined();
  f.queue("same", "1.000001");
  f.queue("top");
  f.queue("other", "2.000001");
  expect(f.output.ready()).toEqual([{ id: "other" }]);
  await f.output.send("same");
  expect(f.post).not.toHaveBeenCalled();
  await f.output.send("other");
  expect(f.post).toHaveBeenCalledOnce();
  expect(f.s.output("old")).toEqual(f.original);
});
it("an unknown top-level legacy send blocks replies in every thread", () => {
  const f = setup({ channel: "CTEST" });
  f.queue("one", "1.000001");
  f.queue("two", "2.000001");
  expect(f.output.ready()).toEqual([]);
});
it("authenticated legacy reconciliation preserves old wire and new dispatch carries its stored hash", async () => {
  const f = setup(),
    normalizer = new CanonicalSlackNormalizer(f.messages, f.mapper, f.output);
  f.s.ingest("AONE", "echo", {
    team_id: "TTEST",
    event: {
      type: "message",
      channel: "CTEST",
      thread_ts: "1.000001",
      ts: "5.000001",
      user: "UONE",
      text: "legacy reply",
      metadata: {
        event_type: "mate_outbox",
        event_payload: { id: "old", request_hash: f.original.request_hash },
      },
    },
  });
  normalizer.normalize("AONE", "echo");
  expect(f.s.output("old")).toMatchObject({
    state: "sent",
    request: f.original.request,
    request_hash: f.original.request_hash,
  });
  f.queue("new", "1.000001");
  await f.output.send("new");
  expect(f.post).toHaveBeenCalledWith(
    expect.objectContaining({
      channel: "CTEST",
      thread_ts: "1.000001",
      metadata: {
        event_type: "mate_outbox",
        event_payload: {
          id: "new",
          request_hash: f.s.output("new")!.request_hash,
        },
      },
    }),
  );
});
it("normal history envelopes apply edited.ts and ignore older replay after restart migration", () => {
  const f = setup(),
    normalizer = new CanonicalSlackNormalizer(f.messages, f.mapper, f.output);
  const ingest = (id: string, event: unknown) => {
    f.s.ingest("AONE", id, { team_id: "TTEST", event });
    normalizer.normalize("AONE", id);
  };
  ingest("history", {
    type: "message",
    channel: "CTEST",
    ts: "1.000001",
    edited: { ts: "3.000001" },
    text: "offline edit",
    user: "UOWNER",
  });
  migrateCanonicalConversations(f.s, configFixture);
  ingest("older", {
    type: "message",
    channel: "CTEST",
    ts: "1.000001",
    text: "stale",
    user: "UOWNER",
  });
  expect(f.messages.read("research", f.target("1.000001"))).toMatchObject([
    { text: "offline edit", revision: "3000001" },
  ]);
});
it("routing is required and immutable, while legacy wire bytes stay unchanged", () => {
  const f = setup();
  expect(() =>
    f.s.queueOutput("research", "unrouted", {
      target: f.target(),
      text: "body",
    }),
  ).toThrow("routing required");
  expect(() =>
    f.s.db
      .prepare("UPDATE outbox SET target=? WHERE id=?")
      .run(encode(f.target("2.000001")), "old"),
  ).toThrow("immutable");
  expect(f.s.output("old")).toEqual(f.original);
});

it("matches documented link/entity/emoji representations while retaining changed content and skin tone", () => {
  expect(
    slackTextMatches(
      "Done 🎉 👍🏼 https://example.com",
      "Done :tada: :thumbsup::skin-tone-3: <https://example.com>",
    ),
  ).toBe(true);
  expect(
    slackTextMatches("Link https://example.com", "Link <https://example.com|https://example.com>"),
  ).toBe(true);
  expect(slackTextMatches("A & B", "A &amp; B")).toBe(true);
  expect(slackTextMatches("Done 👍🏼", "Done :thumbsup::skin-tone-4:")).toBe(false);
  expect(
    slackTextMatches(
      "Link https://example.com",
      "Link <https://other.example|https://example.com>",
    ),
  ).toBe(false);
  expect(slackTextMatches("yes :custom_team:", "no :custom_team:")).toBe(false);
  expect(
    slackTextMatches("literal &lt;https://example.com&gt;", "literal <https://example.com>"),
  ).toBe(false);
});

it("keeps escaped literal Slack controls distinct from active mentions and links", () => {
  for (const token of ["@UOWNER", "!channel", "#CSECRET", "@UOWNER|owner"]) {
    expect(slackTextMatches(`literal &lt;${token}&gt;`, `literal <${token}>`)).toBe(false);
    expect(slackTextMatches(`literal <${token}>`, `literal &lt;${token}&gt;`)).toBe(false);
    expect(slackTextMatches(`active <${token}>`, `active <${token}>`)).toBe(true);
  }
});
