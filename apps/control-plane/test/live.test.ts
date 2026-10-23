import { describe, expect, it } from "vitest";
import { DAY_MS, environment, settle, type Browser, type ServerEvent } from "./support.ts";

type Snapshot = { cursor: string };
type Batch = { events: { cursor: string; type: string; entry?: { body?: string } }[] };

async function general(owner: Browser): Promise<number> {
  const channel = await owner.post("/api/chat/channels", {
    requestId: "general",
    name: "general",
    visibility: "public",
  });
  return (channel.json as { conversationId: number }).conversationId;
}

let posts = 0;
function post(owner: Browser, conversation: number, body: string) {
  return owner.post("/api/chat/messages", {
    timeline: { conversation },
    requestId: `post-${++posts}`,
    body,
  });
}

const bodies = (events: readonly ServerEvent[]) =>
  events
    .filter((event) => event.event === "events")
    .flatMap((event) => (event.data as Batch).events)
    .flatMap((event) => (event.entry?.body === undefined ? [] : [event.entry.body]));

const carrying = (body: string) => (event: ServerEvent) => bodies([event]).includes(body);

describe("the owner's live stream", () => {
  it("sends what is committed after the snapshot's cursor, each batch identified by the cursor after it", async () => {
    const site = await environment().start();
    const owner = site.browser();
    await owner.logInAdmin();
    const conversation = await general(owner);
    await post(owner, conversation, "before the snapshot");
    const { cursor } = (await owner.get("/api/chat/snapshot")).json as Snapshot;

    const stream = await owner.stream(`/api/chat/events?cursor=${encodeURIComponent(cursor)}`);
    await post(owner, conversation, "first");
    const first = await stream.next(carrying("first"));
    const [last] = (first.data as Batch).events.slice(-1);
    expect(first.id, "the batch's id is its last event's cursor").toBe(last?.cursor);
    expect(bodies(stream.events), "nothing from before the cursor").not.toContain(
      "before the snapshot",
    );
    stream.cancel();

    await post(owner, conversation, "while away");
    const resumed = await owner.stream("/api/chat/events", first.id);
    await resumed.next(carrying("while away"));
    expect(bodies(resumed.events), "a reconnect resumes after the last batch it saw").toEqual([
      "while away",
    ]);
  });

  it("carries the owner's unread summary with each batch", async () => {
    const site = await environment().start();
    const owner = site.browser();
    await owner.logInAdmin();
    const { cursor } = (await owner.get("/api/chat/snapshot")).json as Snapshot;
    const stream = await owner.stream(`/api/chat/events?cursor=${encodeURIComponent(cursor)}`);
    await general(owner);
    const batch = await stream.next((event) => event.event === "events");
    expect(batch.data).toMatchObject({ status: "events", unread: { total: 0, mentions: 0 } });
  });

  it("tells the client to load a new snapshot when its cursor cannot be followed, and closes", async () => {
    const site = await environment().start();
    const owner = site.browser();
    await owner.logInAdmin();
    const stream = await owner.stream("/api/chat/events?cursor=not-a-cursor");
    await stream.ended;
    expect(stream.events.map((event) => event.event)).toEqual(["resnapshot"]);
  });

  it("refuses a stream without a cursor, and without a session", async () => {
    const site = await environment().start();
    const owner = site.browser();
    await expect(owner.stream("/api/chat/events?cursor=x"), "no session").rejects.toThrow(/401/);
    await owner.logInAdmin();
    await expect(owner.stream("/api/chat/events"), "no cursor").rejects.toThrow(/400/);
  });

  it("3.9 sends 'login' and closes when the session expires, and sends nothing after", async () => {
    const env = environment();
    const site = await env.start();
    const owner = site.browser();
    await owner.logInAdmin();
    const conversation = await general(owner);
    const { cursor } = (await owner.get("/api/chat/snapshot")).json as Snapshot;
    const stream = await owner.stream(`/api/chat/events?cursor=${encodeURIComponent(cursor)}`);
    await settle();

    env.clock.advance(30 * DAY_MS);
    await stream.ended;
    const later = site.browser();
    await later.logInAdmin();
    await post(later, conversation, "after expiry");
    await settle();
    expect(
      stream.events.map((event) => event.event),
      "only the login event",
    ).toEqual(["login"]);
  });

  it("sends 'login' instead of the next event once the owner has logged out", async () => {
    const site = await environment().start();
    const owner = site.browser();
    await owner.logInAdmin();
    const other = site.browser();
    await other.logInAdmin();
    const conversation = await general(other);
    const { cursor } = (await owner.get("/api/chat/snapshot")).json as Snapshot;
    const stream = await owner.stream(`/api/chat/events?cursor=${encodeURIComponent(cursor)}`);
    await post(other, conversation, "seen");
    await stream.next(carrying("seen"));

    await owner.post("/api/logout");
    await post(other, conversation, "after logout");
    await stream.ended;
    expect(bodies(stream.events), "nothing after logout").toEqual(["seen"]);
    expect(stream.events.at(-1)?.event).toBe("login");
  });
});
