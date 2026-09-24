import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../../src/storage/store.js";
import { configSchema } from "../../src/config.js";
import { configFixture } from "../helpers/config.js";
import { Messages, Output, fixtureTarget } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { CanonicalAttention } from "../../src/conversations/attention.js";
import { CanonicalFreshnessGate } from "../../src/conversations/freshness.js";
import { TeamDirectory } from "../../src/conversations/team-directory.js";
import { Directory } from "../../src/slack/directory.js";
import { ConversationHistory } from "../../src/conversations/history.js";
import { SlackHistory } from "../../src/slack/history.js";
import { CanonicalSlackTransport } from "../../src/slack/transport.js";
import { slackBoundaryWait } from "../../src/slack/readiness.js";
import type { MateConfig } from "../../src/config.js";

/**
 * Every operation that names one external target waits for that target's own platform facts, not
 * only for its installation's connection. The platform reads are spies that would fail this test
 * if they ran, so "waits" means nothing crossed the boundary.
 */
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups.splice(0).forEach((fn) => fn());
});
const twoAgents = {
  ...configFixture,
  agents: [
    configFixture.agents[0],
    {
      ...configFixture.agents[0],
      id: "writer",
      name: "Writer",
      slackAppId: "ATWO",
      slackUserId: "UTWO",
      slackBotId: "BTWO",
      botTokenEnv: "WRITER_BOT",
      appTokenEnv: "WRITER_APP",
      channels: {},
    },
  ],
};
function setup() {
  const store = new Store(":memory:");
  cleanups.push(() => store.close());
  const config = configSchema.parse(twoAgents) as MateConfig,
    messages = new Messages(store, config),
    attention = new CanonicalAttention(messages),
    gate = new CanonicalFreshnessGate(messages, attention),
    output = new Output(messages, { post: async () => ({ ts: "999.000001" }) }, Date.now, gate),
    collaboration = new Collaboration(store, messages, output, config, attention),
    transport = new CanonicalSlackTransport(store, messages.mapper, { research: "synthetic" }),
    client = transport.clients.get("research")!,
    directory = new TeamDirectory(
      messages,
      new Directory(messages, transport.clients, messages.mapper, transport),
    ),
    history = new SlackHistory(messages, transport);
  for (const agent of config.agents) store.register(agent.id, "v1", []);
  messages.membership("research", "CTEST", true);
  // The coverage port is wired exactly as the application assembly wires it.
  const coverage = {
      coverageWait: (actor: string, conversationId: string) =>
        transport.waitingForTarget(actor, conversationId, "history"),
    },
    localHistory = new ConversationHistory(messages, undefined, coverage),
    views = new CanonicalAttention(messages, coverage);
  const work = collaboration.createWork("target-waits", fixtureTarget("CTEST", "100.000001"));
  collaboration.enqueue("research", work, "start", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  const info = vi.fn(async () => {
    throw new Error("The platform was called while the target's permission was unconfirmed");
  });
  client.conversations.info = info as never;
  client.conversations.members = info as never;
  client.conversations.invite = info as never;
  client.conversations.history = info as never;
  /** The installation is connected and verified; only this target's own facts are in question. */
  const readiness = (
    permission: "confirmed" | "unconfirmed" | "denied",
    historyState: "pending" | "complete",
  ) =>
    transport.setReadiness({
      updatedAt: 7,
      installations: [
        { agentId: "research", state: "ready", reason: "connected", attempts: 0, changedAt: 3 },
      ],
      targets: [
        {
          agentId: "research",
          channel: "CTEST",
          conversationId: "CTEST",
          permission,
          history: historyState,
          reason: permission === "confirmed" ? "connected" : "membership_unconfirmed",
          changedAt: 3,
        },
      ],
    });
  return {
    store,
    messages,
    transport,
    client,
    directory,
    history,
    localHistory,
    views,
    readiness,
    info,
    run,
  };
}
const signal = new AbortController().signal;
it("waits for a target's unconfirmed permission before every operation that names it", async () => {
  const f = setup();
  f.readiness("unconfirmed", "pending");
  const target = fixtureTarget("CTEST", "100.000001");
  // A remote history page reports the wait instead of crossing the boundary.
  await expect(f.history.fetch(f.run, target, { limit: 10 }, signal)).resolves.toMatchObject({
    available: false,
    gaps: [expect.stringContaining("no confirmed permission")],
  });
  // Reading one channel's members and inviting a teammate wait for the same missing fact.
  await expect(f.directory.members("research", "CTEST")).rejects.toThrow("no confirmed permission");
  await expect(f.directory.invite(f.run, "invite-1", "CTEST", "writer", signal)).rejects.toThrow(
    "no confirmed permission",
  );
  expect(f.info).not.toHaveBeenCalled();
  // The target's local history view waits for its coverage, so no incomplete page is presented.
  expect(slackBoundaryWait(f.transport, "research", "CTEST", "history")?.message).toContain(
    "catching up on history",
  );
  // Recovery: once the platform fact is confirmed, the same operations cross the boundary.
  f.readiness("confirmed", "complete");
  expect(slackBoundaryWait(f.transport, "research", "CTEST")).toBeUndefined();
  f.client.conversations.info = vi.fn(async () => ({
    ok: true,
    channel: { id: "CTEST", is_member: true },
  })) as never;
  f.client.conversations.members = vi.fn(async () => ({
    ok: true,
    members: ["UONE"],
    response_metadata: {},
  })) as never;
  f.client.conversations.history = vi.fn(async () => ({
    ok: true,
    messages: [],
    response_metadata: {},
  })) as never;
  f.client.conversations.replies = f.client.conversations.history;
  await expect(f.directory.members("research", "CTEST")).resolves.toMatchObject({
    incomplete: false,
  });
  await expect(f.history.fetch(f.run, target, { limit: 10 }, signal)).resolves.toMatchObject({
    available: true,
  });
});
it("makes a local history view and a fresh attention snapshot wait for their coverage", async () => {
  const f = setup(),
    target = { conversationId: "CTEST" };
  f.readiness("confirmed", "pending");
  // A local page may not present an incomplete view as the target's current history, and a fresh
  // snapshot may not mint a sending credential from one.
  expect(() => f.localHistory.page(f.run, { target, limit: 10 })).toThrow("catching up on history");
  expect(() => f.views.read(f.run, target)).toThrow("catching up on history");
  expect(f.info).not.toHaveBeenCalled();
  // Once the target is covered, both read normally: the wait was a fact about coverage, not access.
  f.readiness("confirmed", "complete");
  expect(f.localHistory.page(f.run, { target, limit: 10 })).toMatchObject({ messages: [] });
  expect(f.views.read(f.run, target)).toMatchObject({ viewToken: expect.any(String) });
});
it("keeps a denied target from waiting, because the access check answers for it", async () => {
  const f = setup();
  f.readiness("denied", "pending");
  // The confirmation that saw the denial is what closes access; the boundary itself never waits
  // for a fact that already has an answer.
  f.messages.membership("research", "CTEST", false);
  expect(slackBoundaryWait(f.transport, "research", "CTEST")).toBeUndefined();
  await expect(f.directory.members("research", "CTEST")).rejects.toThrow("access denied");
  await expect(
    f.history.fetch(f.run, fixtureTarget("CTEST", "100.000001"), { limit: 10 }, signal),
  ).rejects.toThrow("access denied");
  expect(f.info).not.toHaveBeenCalled();
});
