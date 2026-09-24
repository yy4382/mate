import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/daemon/app.js";
import { daemonFixture } from "../helpers/daemon-config.js";
import { configFixture } from "../helpers/config.js";
import { slackSockets } from "../helpers/slack-connection.js";
import type { CanonicalSlackTransport } from "../../src/slack/transport.js";
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const log = { info: () => {}, error: () => {} };
function credentials() {
  const refs = ["MODEL_API_KEY", "RESEARCH_BOT_TOKEN", "RESEARCH_APP_TOKEN"],
    saved = Object.fromEntries(refs.map((ref) => [ref, process.env[ref]]));
  for (const ref of refs) process.env[ref] = "synthetic";
  cleanups.push(() => {
    for (const ref of refs) {
      if (saved[ref] === undefined) delete process.env[ref];
      else process.env[ref] = saved[ref];
    }
  });
}
/** A deployment that serves Slack and one internal room, like the managed one. */
function deployment() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-offline-"))),
    data = join(root, "data");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const config = daemonFixture(data, {
    ...configFixture,
    agents: [
      {
        ...configFixture.agents[0],
        model: { provider: "anthropic", id: "claude-haiku-4-5", apiKeyEnv: "MODEL_API_KEY" },
      },
    ],
  });
  config.adapters.local = {
    humans: ["owner"],
    rooms: [{ id: "local-room", agents: ["research"], humans: ["owner"] }],
  };
  return { config, data };
}
/** The platform answers the connection verification; the socket is what this test controls. */
function platformAnswers(daemon: Daemon) {
  const client = daemon.application.transport!.clients.get("research")!;
  client.auth.test = vi.fn(async () => ({
    team_id: "TTEST",
    user_id: "UONE",
    bot_id: "BONE",
  })) as never;
  client.bots.info = vi.fn(async () => ({ bot: { app_id: "AONE" } })) as never;
  client.users.conversations = vi.fn(async () => ({ channels: [] })) as never;
  client.conversations.info = vi.fn(async ({ channel }: { channel: string }) => ({
    channel: { id: channel, is_member: true },
  })) as never;
  client.conversations.history = vi.fn(async () => ({ messages: [] })) as never;
}
function externalTarget(daemon: Daemon) {
  const messages = daemon.collaboration.messages;
  messages.references.createConversation("channel", "external", "CTEST");
  messages.references.bindConversation(
    { provider: "slack", workspace: "TTEST", externalId: "CTEST" },
    "CTEST",
    "primary",
  );
  messages.membership("research", "CTEST", true);
  return { conversationId: "CTEST" };
}
/** Remote success evidence from the real Slack mapper, without touching the network. */
function confirmingPost(transport: CanonicalSlackTransport) {
  let seq = 0;
  return vi.spyOn(transport, "post").mockImplementation(async (request) => {
    const agent = transport.mapper.config.agents.find((a) => a.id === request.actor)!,
      ts = `300.${String(++seq).padStart(6, "0")}`;
    return {
      message: transport.mapper.message({
        channel: "CTEST",
        ts,
        revision: ts,
        text: request.text,
        user: agent.slackUserId,
        bot: agent.slackBotId,
        deleted: false,
      }),
      receipt: { ts },
    } as never;
  });
}
/** Queue one external publication through the freshness gate, as a tool call would. */
function queueExternal(
  daemon: Daemon,
  work: string,
  run: { id: string },
  id: string,
  text: string,
) {
  daemon.collaboration.send("research", work, { conversationId: "CTEST" }, id, id, {
    run: run as never,
  });
  const draft = daemon.application.gate.describe("research", id) as {
    revision: number;
    holdId: string;
  };
  daemon.application.gate.continueOnce(run as never, id, draft.revision, draft.holdId);
}
async function openRun(daemon: Daemon, target: { conversationId: string }) {
  const work = daemon.collaboration.createWork("offline-external", target);
  daemon.collaboration.enqueue("research", work, "start", {});
  // The scheduler may be finishing the internal and reminder runs; take the next free run.
  const run = await vi.waitFor(() => {
    const token = daemon.store.beginRun("research");
    if (!token) throw new Error("Agent already has an active run");
    return token;
  });
  daemon.store.input(run, {});
  return { work, run };
}
it("keeps internal work running while Slack is offline and publishes what waited once it recovers", async () => {
  credentials();
  const { config } = deployment();
  let offline = true;
  // While offline the socket never completes: the installation stays connecting, not failed.
  const sockets = slackSockets((socket) => {
    if (offline) socket.hold();
  });
  const daemon = await Daemon.create(config, log, process.cwd(), { slackSocket: sockets.socket });
  cleanups.push(() => daemon.close());
  platformAnswers(daemon);
  const tools: string[] = [];
  let runs = 0;
  vi.spyOn(daemon.supervisor, "recovery").mockResolvedValue("synthetic private memory");
  vi.spyOn(daemon.supervisor, "factory").mockImplementation(() => ({
    close() {},
    async run(_spec, hooks) {
      const run = runs++;
      const read = await hooks.tool(`read-${run}`, "file.read", { path: "MEMORY.md" });
      tools.push(((read.value as { stdout?: string }).stdout ?? "").trim());
      const draft = (
        await hooks.tool(`reply-${run}`, "messages.send", {
          target: { conversationId: "local-room" },
          text: "internal answer",
        })
      ).value as { draftId: string; revision: number; holdId: string };
      await hooks.tool(`confirm-${run}`, "drafts.continue", {
        draftId: draft.draftId,
        revision: draft.revision,
        holdId: draft.holdId,
        acknowledge: "send_despite_unread_or_changes",
      });
      return { tokens: 3, cost: 0, certain: true, waiting: false, continuation: false };
    },
  }));
  const posted = confirmingPost(daemon.application.transport!);
  // AC1: the daemon is running while its Slack installation is still connecting.
  await daemon.start();
  expect(daemon.slackReadiness()).toMatchObject({
    ready: false,
    installations: [{ agentId: "research", state: "connecting" }],
  });
  // AC2: an authorized internal conversation completes offline, through ordinary execution.
  // The Agent follows this room, so its message wakes the Agent instead of waiting for a batch.
  daemon.collaboration.messages.watch("research", { conversationId: "local-room" }, true);
  daemon.local!.receive(
    "owner",
    "offline-input",
    { conversationId: "local-room" },
    "are you there?",
  );
  await vi.waitFor(
    () =>
      expect(
        daemon
          .local!.read("owner", { conversationId: "local-room" })
          .messages.some((message) => message.text === "internal answer"),
      ).toBe(true),
    { timeout: 5000 },
  );
  expect(tools.some((stdout) => stdout.includes("Research"))).toBe(true);
  // AC2: a reminder that comes due offline still fires for its author.
  const reminderWork = daemon.collaboration.createWork("offline-reminder", {
      conversationId: "local-room",
    }),
    reminder = daemon.collaboration.reminders.create("research", reminderWork, {
      target: { conversationId: "local-room" },
      content: "offline reminder",
      nextAt: Date.now() - 1,
      timezone: "UTC",
    });
  await vi.waitFor(
    () =>
      expect(
        daemon.store.db
          .prepare("SELECT count(*) n FROM reminder_firings WHERE reminder_id=?")
          .get(reminder.id),
      ).toEqual({ n: 1 }),
    { timeout: 5000 },
  );
  // AC2: the Slack-dependent publication waits in its durable record instead of failing.
  const target = externalTarget(daemon),
    { work, run } = await openRun(daemon, target);
  queueExternal(daemon, work, run, "offline-external", "sent after recovery");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  expect(daemon.store.output("offline-external")!.state).toBe("pending");
  expect(posted).not.toHaveBeenCalled();
  // Recovery: the installation becomes ready on its own and the waited message is published once.
  offline = false;
  sockets.created.forEach((entry) => entry.socket.release());
  await vi.waitFor(() => expect(daemon.slackReadiness().ready).toBe(true), { timeout: 5000 });
  await vi.waitFor(() => expect(daemon.store.output("offline-external")!.state).toBe("sent"), {
    timeout: 5000,
  });
  expect(posted).toHaveBeenCalledOnce();
  // AC3: a socket dropped while running only takes its own installation out of service.
  sockets.forAgent("research")!.drop();
  await vi.waitFor(() => expect(daemon.slackReadiness().ready).toBe(false), { timeout: 5000 });
  expect(daemon.slackReadiness().installations[0]).toMatchObject({
    state: "waiting",
    reason: "transport_gap",
  });
  expect(
    daemon.local!.read("owner", { conversationId: "local-room" }).messages.length,
  ).toBeGreaterThan(0);
});
