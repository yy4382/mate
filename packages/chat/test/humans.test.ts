import { join } from "node:path";
import { FakeClock, temporaryDirectory } from "@mate/testkit";
import { describe, expect, it } from "vitest";
import type { ChatApp, LiveEvent, TimelineRef } from "../src/index.ts";
import {
  FakePushService,
  openAppAt,
  refusalReason,
  rid,
  settled,
  subscription,
} from "./support.ts";

/** Two humans, Hana and Hugo, and two Agents, Ada and Bo, on a store with a push service. */
function household() {
  const clock = new FakeClock();
  const service = new FakePushService(clock);
  const app = openAppAt(join(temporaryDirectory(), "chat.sqlite"), { clock, push: service.send });
  const account = (name: string, kind: "human" | "agent") =>
    app.ensureAccount({ externalId: name, displayName: name, handle: name, kind });
  const hana = account("hana", "human");
  const hugo = account("hugo", "human");
  const ada = account("ada", "agent");
  const bo = account("bo", "agent");
  return { app, clock, service, hana, hugo, ada, bo };
}

function dm(app: ChatApp, from: number, to: number): TimelineRef {
  return { conversation: app.openDm(from, { requestId: rid(), other: to }).conversationId };
}

function post(
  app: ChatApp,
  from: number,
  timeline: TimelineRef,
  body: string,
  mentions: number[] = [],
) {
  const result = app.send(from, timeline, { requestId: rid(), body, freshness: false, mentions });
  if (result.status !== "sent") throw new Error("expected sent");
  return result;
}

/** What a client following `viewer`'s live events has been told since the previous call. */
function follow(app: ChatApp, viewer: number): () => LiveEvent[] {
  let cursor = app.liveSnapshot(viewer).cursor;
  return () => {
    const read = app.liveEvents(viewer, cursor);
    if (read.status === "resnapshot") throw new Error("the follower fell behind");
    cursor = read.cursor;
    return read.events;
  };
}

const types = (events: LiveEvent[]) => events.map((event) => event.type);

describe("3.11 human accounts", () => {
  it("every human reads every conversation, an Agent DM included, while an Agent does not read a private conversation it is not in", () => {
    const { app, hana, hugo, ada, bo } = household();
    const agents = dm(app, ada, bo);
    post(app, ada, agents, "Bo, can you review?");
    const secret = app.createChannel(ada, {
      requestId: rid(),
      name: "secret",
      visibility: "private",
    });

    for (const human of [hana, hugo]) {
      expect(app.listConversations(human).map((c) => c.conversationId)).toContain(
        secret.conversationId,
      );
      expect(
        app.readHistory(human, agents).map((entry) => entry.kind === "message" && entry.body),
        "a human reads the Agents' DM",
      ).toEqual(["Bo, can you review?"]);
    }
    expect(
      refusalReason(() => app.readHistory(bo, { conversation: secret.conversationId })),
      "an Agent outside a private channel does not see it",
    ).toBe("not-found");
    app.close();
  });

  it("a human's read position reaches that human's live events and no other human's, while entries, conversations and accounts reach both", () => {
    const { app, hana, hugo, ada } = household();
    const general = app.createChannel(hana, {
      requestId: rid(),
      name: "general",
      visibility: "public",
    });
    const top = { conversation: general.conversationId };
    app.join(ada, { requestId: rid(), conversationId: general.conversationId });
    const hanaEvents = follow(app, hana);
    const hugoEvents = follow(app, hugo);

    post(app, ada, top, "hello");
    app.ensureAccount({ externalId: "ada", displayName: "Ada L", handle: "ada", kind: "agent" });
    app.readUnread(hana, top, { requestId: rid() });

    expect(types(hanaEvents()), "Hana sees the change and her own read").toEqual([
      "entry",
      "account",
      "read",
    ]);
    expect(types(hugoEvents()), "Hugo sees the change, not Hana's read").toEqual([
      "entry",
      "account",
    ]);

    app.readUnread(hugo, top, { requestId: rid() });
    expect(types(hugoEvents())).toEqual(["read"]);
    expect(types(hanaEvents()), "Hugo's read is not Hana's").toEqual([]);
    app.close();
  });

  it("a human whose events are all for others still moves forward, and the snapshot says which account the viewer is", () => {
    const { app, hana, hugo, ada } = household();
    const top = dm(app, ada, hana);
    post(app, ada, top, "hi");
    const before = app.liveSnapshot(hugo);
    expect(before.me).toBe(hugo);
    expect(app.liveSnapshot(hana).me).toBe(hana);

    app.readUnread(hana, top, { requestId: rid() });
    const read = app.liveEvents(hugo, before.cursor);
    if (read.status !== "events") throw new Error("expected events");
    expect(read.events, "Hana's read is not Hugo's").toEqual([]);
    expect(read.cursor, "past Hana's read event").not.toBe(before.cursor);
    expect(app.liveEvents(hugo, read.cursor)).toMatchObject({ status: "events", events: [] });
    app.close();
  });

  it("each human has their own unread summary", () => {
    const { app, hana, hugo, ada } = household();
    post(app, ada, dm(app, ada, hana), "for Hana");
    const other = dm(app, ada, hugo);
    post(app, ada, other, "for Hugo");
    post(app, ada, other, "again for Hugo");

    expect(app.unreadSummary(hana).total).toBe(1);
    expect(app.unreadSummary(hugo).total).toBe(2);
    app.readUnread(hugo, other, { requestId: rid() });
    expect(app.unreadSummary(hugo).total).toBe(0);
    expect(app.unreadSummary(hana).total, "Hugo's reading did not touch Hana's").toBe(1);
    app.close();
  });

  it("a push for a DM goes to that human's subscriptions only, a mention of the other human pushes theirs, and a deactivated human gets none", async () => {
    const { app, service, hana, hugo, ada } = household();
    app.subscribePush(hana, subscription("hana-phone"));
    app.subscribePush(hugo, subscription("hugo-phone"));

    post(app, ada, dm(app, ada, hana), "for Hana");
    await service.received(1);
    await settled();
    expect(service.endpoints(), "only Hana's device").toEqual([
      subscription("hana-phone").endpoint,
    ]);

    const general = app.createChannel(hana, {
      requestId: rid(),
      name: "general",
      visibility: "public",
    });
    const top = { conversation: general.conversationId };
    app.join(ada, { requestId: rid(), conversationId: general.conversationId });
    app.invite(hana, { requestId: rid(), conversationId: general.conversationId, invitee: hugo });
    post(app, ada, top, "@hugo look", [hugo]);
    await service.received(2);
    await settled();
    expect(service.requests.at(-1)).toMatchObject({
      subscription: { endpoint: subscription("hugo-phone").endpoint },
      notice: { mentioned: true },
    });
    expect(service.requests, "Hana is not notified of a mention of Hugo").toHaveLength(2);

    const toHugo = dm(app, ada, hugo);
    app.deactivateAccount(hugo, { requestId: rid() });
    post(app, ada, toHugo, "Hugo?");
    await settled();
    expect(service.requests, "a deactivated human gets nothing").toHaveLength(2);
    app.close();
  });

  it("subscribing an endpoint that another human holds moves it to the new human", async () => {
    const { app, service, hana, hugo, ada } = household();
    app.subscribePush(hana, subscription("shared-tablet"));
    app.subscribePush(hugo, subscription("shared-tablet"));

    post(app, ada, dm(app, ada, hana), "for Hana");
    await settled();
    expect(service.requests, "the tablet is Hugo's now").toEqual([]);

    post(app, ada, dm(app, ada, hugo), "for Hugo");
    await service.received(1);
    expect(service.endpoints()).toEqual([subscription("shared-tablet").endpoint]);
    app.close();
  });

  it("an Agent account cannot use the live view or subscribe to push", () => {
    const { app, hana, ada } = household();
    const cursor = app.liveSnapshot(hana).cursor;
    expect(refusalReason(() => app.liveSnapshot(ada))).toBe("human-only");
    expect(refusalReason(() => app.liveEvents(ada, cursor))).toBe("human-only");
    expect(refusalReason(() => app.subscribePush(ada, subscription("ada-phone")))).toBe(
      "human-only",
    );
    app.close();
  });

  it("ensureAccount refuses to change an existing account's kind", () => {
    const { app } = household();
    const ensure = (name: string, kind: "human" | "agent") => () =>
      app.ensureAccount({ externalId: name, displayName: name, handle: name, kind });
    expect(refusalReason(ensure("hana", "agent"))).toBe("invalid-input");
    expect(refusalReason(ensure("ada", "human"))).toBe("invalid-input");
    expect(app.listAccounts().map((account) => [account.handle, account.kind])).toEqual([
      ["hana", "human"],
      ["hugo", "human"],
      ["ada", "agent"],
      ["bo", "agent"],
    ]);
    app.close();
  });
});
