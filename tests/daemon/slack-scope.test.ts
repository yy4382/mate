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
const references = [
  "MODEL_API_KEY",
  "RESEARCH_BOT_TOKEN",
  "RESEARCH_APP_TOKEN",
  "WRITER_BOT_TOKEN",
  "WRITER_APP_TOKEN",
];
function credentials(): void {
  const saved = Object.fromEntries(references.map((ref) => [ref, process.env[ref]]));
  for (const ref of references) process.env[ref] = "synthetic";
  cleanups.push(() => {
    for (const ref of references) {
      if (saved[ref] === undefined) delete process.env[ref];
      else process.env[ref] = saved[ref];
    }
  });
}
/** Two installations and one internal room, like the managed deployment. */
function deployment() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-scope-"))),
    data = join(root, "data");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const model = { provider: "anthropic", id: "claude-haiku-4-5", apiKeyEnv: "MODEL_API_KEY" },
    config = daemonFixture(data, {
      ...configFixture,
      agents: [
        {
          ...configFixture.agents[0],
          model,
          channels: { CTEST: "mentions", CTWO: "mentions" },
        },
        {
          ...configFixture.agents[0],
          id: "writer",
          name: "Writer",
          slackAppId: "ATWO",
          slackUserId: "UTWO",
          slackBotId: "BTWO",
          botTokenEnv: "WRITER_BOT_TOKEN",
          appTokenEnv: "WRITER_APP_TOKEN",
          model,
          channels: { CWRT: "mentions" },
        },
      ],
    });
  config.adapters.local = {
    humans: ["owner"],
    rooms: [{ id: "local-room", agents: ["research", "writer"], humans: ["owner"] }],
  };
  return { data, config };
}
/** The platform answers this test decides; the socket stays under the test's control. */
interface Platform {
  auth?: (agentId: string) => void;
  info?: (agentId: string, channel: string) => void;
}
function platformAnswers(daemon: Daemon, behavior: Platform = {}) {
  for (const agent of daemon.application.transport!.mapper.config.agents) {
    const client = daemon.application.transport!.clients.get(agent.id)!;
    client.auth.test = vi.fn(async () => {
      behavior.auth?.(agent.id);
      return { team_id: "TTEST", user_id: agent.slackUserId, bot_id: agent.slackBotId };
    }) as never;
    client.bots.info = vi.fn(async () => ({ bot: { app_id: agent.slackAppId } })) as never;
    client.users.conversations = vi.fn(async () => ({ channels: [] })) as never;
    client.conversations.info = vi.fn(async ({ channel }: { channel: string }) => {
      behavior.info?.(agent.id, channel);
      return { channel: { id: channel, is_member: true } };
    }) as never;
    client.conversations.history = vi.fn(async () => ({ messages: [] })) as never;
  }
}
/** One external channel of one Agent, as an invitation or a discovery would have left it. */
function externalTarget(daemon: Daemon, channel: string, agentId = "research") {
  const messages = daemon.collaboration.messages;
  messages.references.createConversation("channel", "external", channel);
  messages.references.bindConversation(
    { provider: "slack", workspace: "TTEST", externalId: channel },
    channel,
    "primary",
  );
  messages.membership(agentId, channel, true);
  return { conversationId: channel };
}
/** Remote success evidence from the real Slack mapper, without touching the network. */
function confirmingPost(transport: CanonicalSlackTransport) {
  let seq = 0;
  return vi.spyOn(transport, "post").mockImplementation(async (request) => {
    const agent = transport.mapper.config.agents.find((a) => a.id === request.actor)!,
      ts = `300.${String(++seq).padStart(6, "0")}`;
    return {
      message: transport.mapper.message({
        channel: request.target.conversationId,
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
type Captured = Record<string, any>;
interface Step {
  operation: string;
  args: (captured: Captured) => unknown;
}
/**
 * Scripted Agents for the real application: each run performs the tool calls this test queued for
 * that Agent, through the same router a model would use. A failing call is recorded instead of
 * ending the test, so the assertions decide what a failure means.
 */
function scriptedAgents(daemon: Daemon) {
  const queue = new Map<string, Step[][]>(),
    captured = new Map<string, Captured>(),
    failures: string[] = [];
  let call = 0;
  vi.spyOn(daemon.supervisor, "recovery").mockResolvedValue("synthetic private memory");
  vi.spyOn(daemon.supervisor, "factory").mockImplementation((agent) => ({
    close() {},
    async run(_spec, hooks) {
      const script = queue.get(agent.id)?.shift() ?? [],
        values: Captured = {},
        // Every run names its calls apart: a repeated call id is a replayed effect, not a new one.
        prefix = `${agent.id}-${++call}`;
      captured.set(agent.id, values);
      for (const [index, step] of script.entries()) {
        try {
          const id = `${prefix}-${step.operation}-${index}`;
          const outcome = await hooks.tool(id, step.operation, step.args(values));
          values[`${step.operation}-${index}`] = outcome.value;
          values[step.operation] = outcome.value;
        } catch (error) {
          failures.push(`${step.operation}: ${String(error)}`);
        }
      }
      return { tokens: 2, cost: 0, certain: true, waiting: false, continuation: false };
    },
  }));
  return {
    failures,
    captured,
    add: (agentId: string, ...steps: Step[]) => {
      const runs = queue.get(agentId) ?? [];
      runs.push(steps);
      queue.set(agentId, runs);
    },
    /** Deliver one message into the internal room, which wakes every member that follows it. */
    kick: (daemon: Daemon, id: string) => {
      for (const agentId of ["research", "writer"])
        daemon.collaboration.messages.watch(agentId, { conversationId: "local-room" }, true);
      daemon.local!.receive("owner", id, { conversationId: "local-room" }, "go");
    },
  };
}
const send = (text: string, conversationId: string, viewToken?: string): Step => ({
  operation: "messages.send",
  args: () => ({ target: { conversationId }, text, ...(viewToken ? { viewToken } : {}) }),
});
const continueDraft: Step = {
  operation: "drafts.continue",
  args: (captured) => {
    const draft = captured["messages.send"] as {
      draftId: string;
      revision: number;
      holdId: string;
    };
    return {
      draftId: draft.draftId,
      revision: draft.revision,
      holdId: draft.holdId,
      acknowledge: "send_despite_unread_or_changes",
    };
  },
};
/** A Slack timestamp from now, as a message delivered while the test runs would carry. */
const nowTs = () => `${Math.floor(Date.now() / 1000) + 1}.000001`;
/** The outbox row one Agent publication produced, found by the text it carries. */
const outputOf = (daemon: Daemon, text: string) =>
  daemon.store.db
    .prepare("SELECT id,state FROM outbox WHERE json_extract(request,'$.text')=?")
    .get(text) as { id: string; state: string } | undefined;
const draftOf = (daemon: Daemon, text: string) =>
  (
    daemon.store.db
      .prepare(
        "SELECT d.id id FROM drafts d JOIN outbox o ON o.id=d.outbox_id WHERE json_extract(o.request,'$.text')=?",
      )
      .get(text) as { id: string }
  ).id;
const internalMessage = (daemon: Daemon, text: string) =>
  daemon
    .local!.read("owner", { conversationId: "local-room" })
    .messages.some((message) => message.text === text);
it("keeps a failing installation from pausing the other installation and internal work", async () => {
  credentials();
  const { config } = deployment(),
    sockets = slackSockets(),
    daemon = await Daemon.create(config, log, process.cwd(), {
      slackSocket: sockets.socket,
      // The harness decides how quickly a not-ready installation or target is retried.
      slackBackoff: { baseMs: 120, maxMs: 480 },
    });
  cleanups.push(() => daemon.close());
  platformAnswers(daemon, {
    auth: (agentId) => {
      if (agentId === "research")
        throw { code: "slack_webapi_platform_error", data: { error: "invalid_auth" } };
    },
  });
  const writerTarget = externalTarget(daemon, "CWRT", "writer"),
    researchTarget = externalTarget(daemon, "CTEST"),
    agents = scriptedAgents(daemon),
    posted = confirmingPost(daemon.application.transport!);
  agents.add(
    "research",
    send("internal answer", "local-room"),
    continueDraft,
    send("waiting answer", researchTarget.conversationId),
    continueDraft,
  );
  agents.add("writer", send("writer answer", writerTarget.conversationId), continueDraft);
  await daemon.start();
  // AC4: a partial installation failure names the human action for that installation alone.
  await vi.waitFor(() =>
    expect(
      daemon.slackReadiness().installations.find((entry) => entry.agentId === "research"),
    ).toMatchObject({ state: "needs-human", reason: "invalid_auth" }),
  );
  await vi.waitFor(() =>
    expect(
      daemon.slackReadiness().installations.find((entry) => entry.agentId === "writer"),
    ).toMatchObject({ state: "ready" }),
  );
  expect(daemon.slackReadiness().ready).toBe(false);
  expect(
    daemon.slackReadiness().installations.find((entry) => entry.agentId === "research")!.action,
  ).toContain("Replace the Slack tokens of research");
  agents.kick(daemon, "scope-kick");
  // The healthy installation still crosses the boundary while the other needs an operator.
  await vi.waitFor(() => expect(outputOf(daemon, "writer answer")!.state).toBe("sent"), {
    timeout: 5000,
  });
  expect(posted.mock.calls.map(([request]) => request.actor)).toEqual(["writer"]);
  // The failed installation's Slack-dependent send waits in its durable record.
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect(outputOf(daemon, "waiting answer")!.state).toBe("pending");
  // AC4: an authorized internal conversation and ordinary execution continue all the same.
  await vi.waitFor(() => expect(internalMessage(daemon, "internal answer")).toBe(true), {
    timeout: 5000,
  });
  expect(agents.failures).toEqual([]);
  expect(daemon.store.db.prepare("SELECT count(*) n FROM agents WHERE paused=1").get()).toEqual({
    n: 0,
  });
});
it(
  "keeps one unverified target waiting without pausing its installation's other targets",
  { timeout: 20000 },
  async () => {
    credentials();
    const { config } = deployment(),
      // The next connection attempt waits until this test allows it, so the reply is queued while
      // the installation is between connections.
      sockets = slackSockets((socket) => socket.hold()),
      daemon = await Daemon.create(config, log, process.cwd(), {
        slackSocket: sockets.socket,
        // The harness decides how quickly a not-ready installation or target is retried.
        slackBackoff: { baseMs: 120, maxMs: 480 },
      });
    cleanups.push(() => daemon.close());
    let refuse = false;
    platformAnswers(daemon, {
      info: (_agentId, channel) => {
        if (refuse && channel === "CTWO")
          throw { code: "slack_webapi_platform_error", data: { error: "internal_error" } };
      },
    });
    const healthy = externalTarget(daemon, "CTEST"),
      broken = externalTarget(daemon, "CTWO"),
      agents = scriptedAgents(daemon),
      posted = confirmingPost(daemon.application.transport!),
      messages = daemon.collaboration.messages,
      releaseConnections = () => sockets.created.forEach((entry) => entry.socket.release());
    await daemon.start();
    const transport = daemon.application.transport!;
    releaseConnections();
    await vi.waitFor(() => expect(daemon.slackReadiness().ready).toBe(true));
    await vi.waitFor(() =>
      expect(transport.waitingForTarget("research", "CTWO", "history")).toBeUndefined(),
    );
    // A connection gap invalidates every target's platform facts without clearing the cached grant,
    // and the platform stops answering for one of them before the connection returns.
    sockets.forAgent("research")!.drop();
    refuse = true;
    await vi.waitFor(() => expect(transport.readyFor("research")).toBe(false));
    expect(messages.access("research", broken.conversationId)).toBe(true);
    // The Agent replies to both targets while the installation is reconnecting.
    agents.add(
      "research",
      send("healthy answer", healthy.conversationId),
      continueDraft,
      send("waiting answer", broken.conversationId),
      continueDraft,
    );
    agents.kick(daemon, "target-kick");
    await vi.waitFor(() =>
      expect(
        daemon.store.db.prepare("SELECT count(*) n FROM outbox WHERE state='pending'").get(),
      ).toEqual({ n: 2 }),
    );
    // One target cannot confirm its permission after the reconnect; the other is verified again.
    releaseConnections();
    await vi.waitFor(() => expect(transport.readyFor("research")).toBe(true), { timeout: 8000 });
    await vi.waitFor(() =>
      expect(transport.waitingForTarget("research", "CTWO", "permission")).toBeDefined(),
    );
    expect(transport.waitingForTarget("research", "CTEST", "permission")).toBeUndefined();
    await vi.waitFor(() => expect(outputOf(daemon, "healthy answer")!.state).toBe("sent"), {
      timeout: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    // The unconfirmed permission keeps the other publication queued, not revoked and not sent.
    expect(outputOf(daemon, "waiting answer")!.state).toBe("pending");
    expect(posted.mock.calls.map(([request]) => request.text)).toEqual(["healthy answer"]);
    expect(messages.access("research", broken.conversationId)).toBe(false);
    expect(agents.failures).toEqual([]);
    // Recovery is scoped to that target: it reconfirms its permission and publishes what waited.
    refuse = false;
    await vi.waitFor(() => expect(outputOf(daemon, "waiting answer")!.state).toBe("sent"), {
      timeout: 20000,
    });
    expect(posted.mock.calls.map(([request]) => request.text)).toEqual([
      "healthy answer",
      "waiting answer",
    ]);
  },
);
it(
  "still checks discussion freshness for a publication that waited for recovery",
  { timeout: 20000 },
  async () => {
    credentials();
    const { config } = deployment(),
      sockets = slackSockets(),
      daemon = await Daemon.create(config, log, process.cwd(), {
        slackSocket: sockets.socket,
        // The harness decides how quickly a not-ready installation or target is retried.
        slackBackoff: { baseMs: 120, maxMs: 480 },
      });
    cleanups.push(() => daemon.close());
    platformAnswers(daemon);
    const target = externalTarget(daemon, "CTWO"),
      agents = scriptedAgents(daemon),
      posted = confirmingPost(daemon.application.transport!),
      transport = daemon.application.transport!;
    // The Agent presents the discussion, then the connection drops before it replies.
    agents.add("research", {
      operation: "attention.read",
      args: () => ({ target: { conversationId: target.conversationId } }),
    });
    await daemon.start();
    await vi.waitFor(() => expect(daemon.slackReadiness().ready).toBe(true));
    await vi.waitFor(() =>
      expect(transport.waitingForTarget("research", "CTWO", "history")).toBeUndefined(),
    );
    agents.kick(daemon, "view-kick");
    await vi.waitFor(() =>
      expect(agents.captured.get("research")?.["attention.read"]).toBeDefined(),
    );
    const viewToken = agents.captured.get("research")!["attention.read"].viewToken as string;
    expect(viewToken).toBeTruthy();
    sockets.forAgent("research")!.drop();
    await vi.waitFor(() => expect(transport.readyFor("research")).toBe(false));
    // The reply waits in its durable record, and so does its presentation.
    agents.add("research", send("waited answer", target.conversationId, viewToken));
    agents.kick(daemon, "waiting-kick");
    await vi.waitFor(() =>
      expect(daemon.store.db.prepare("SELECT count(*) n FROM drafts").get()).toEqual({ n: 1 }),
    );
    // The discussion moves while the publication waits for its target to recover.
    daemon.store.ingest("AONE", "scope-inbound", {
      team_id: "TTEST",
      event: {
        type: "message",
        channel: "CTWO",
        ts: nowTs(),
        text: "a newer decision",
        user: "UOWNER",
      },
    });
    await vi.waitFor(() =>
      expect(
        daemon.store.db
          .prepare("SELECT normalized FROM ingress WHERE event_id=?")
          .get("scope-inbound"),
      ).toEqual({ normalized: 1 }),
    );
    // AC2: recovery does not publish the queued message from its stale presentation.
    await vi.waitFor(() => expect(transport.readyFor("research")).toBe(true), { timeout: 8000 });
    await vi.waitFor(() =>
      expect(transport.waitingForTarget("research", "CTWO", "history")).toBeUndefined(),
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(outputOf(daemon, "waited answer")!.state).toBe("held");
    expect(posted).not.toHaveBeenCalled();
    // The Agent's own next run sees the durable hold and continues explicitly; the message is never
    // published by recovery itself.
    agents.add("research", {
      operation: "drafts.continue",
      args: () => {
        const draft = daemon.application.gate.describe(
          "research",
          draftOf(daemon, "waited answer"),
        ) as { draftId: string; revision: number; holdId: string };
        return {
          draftId: draft.draftId,
          revision: draft.revision,
          holdId: draft.holdId,
          acknowledge: "send_despite_unread_or_changes",
        };
      },
    });
    agents.kick(daemon, "explicit-continue");
    await vi.waitFor(() => expect(outputOf(daemon, "waited answer")!.state).toBe("sent"), {
      timeout: 5000,
    });
    expect(posted).toHaveBeenCalledOnce();
    expect(agents.failures).toEqual([]);
  },
);
it(
  "records a projection failure without rolling back the internal message, apart from the import",
  { timeout: 20000 },
  async () => {
    credentials();
    const { config } = deployment(),
      sockets = slackSockets(),
      daemon = await Daemon.create(config, log, process.cwd(), {
        slackSocket: sockets.socket,
        // The harness decides how quickly a not-ready installation or target is retried.
        slackBackoff: { baseMs: 120, maxMs: 480 },
      });
    cleanups.push(() => daemon.close());
    platformAnswers(daemon);
    const agents = scriptedAgents(daemon),
      posted = confirmingPost(daemon.application.transport!);
    agents.add("research", send("shown", "local-room"), continueDraft);
    await daemon.start();
    await vi.waitFor(() => expect(daemon.slackReadiness().ready).toBe(true));
    // Owner-authorized disclosure of one internal room into a Slack channel.
    const store = daemon.store,
      owner = daemon.config.mate.ownerUserIds[0]!;
    store.db
      .prepare("INSERT INTO internal_members VALUES(?,'human',?) ON CONFLICT DO NOTHING")
      .run("local-room", owner);
    const bindingId = daemon.projections.core.configure(
      "local-room",
      { provider: "slack", workspace: "TTEST", externalId: "CDISPLAY" },
      "research",
      [{ kind: "human", id: owner }],
      true,
    );
    // Slack refuses the projection; the internal publication it presents is unaffected by that.
    daemon.application.transport!.clients.get("research")!.chat.postMessage = vi.fn(async () => {
      throw { code: "slack_webapi_platform_error", data: { error: "channel_not_found" } };
    }) as never;
    agents.kick(daemon, "projection-kick");
    // The internal message is committed first; the projection is a separate outbox row.
    await vi.waitFor(() => expect(outputOf(daemon, "shown")!.state).toBe("sent"));
    const messageId = JSON.parse(store.output(outputOf(daemon, "shown")!.id)!.receipt!)
      .messageId as string;
    await vi.waitFor(
      () =>
        expect(
          store.db
            .prepare("SELECT state FROM projection_outbox WHERE binding_id=? AND message_id=?")
            .get(bindingId, messageId),
        ).toMatchObject({ state: "failed" }),
      { timeout: 8000 },
    );
    expect(outputOf(daemon, "shown")!.state).toBe("sent");
    expect(daemon.collaboration.messages.records.message(messageId)!.deleted).toBe(false);
    expect(internalMessage(daemon, "shown")).toBe(true);
    // A controlled import in the other direction keeps its own result record.
    const imported = nowTs();
    daemon.store.ingest("AONE", "scope-import", {
      team_id: "TTEST",
      event: {
        type: "message",
        channel: "CDISPLAY",
        ts: imported,
        text: "imported answer",
        user: "UOWNER",
      },
    });
    daemon.slack.replay();
    await vi.waitFor(() =>
      expect(
        store.db
          .prepare("SELECT status FROM projection_imports WHERE binding_id=? AND external_id=?")
          .get(bindingId, imported),
      ).toMatchObject({ status: "applied" }),
    );
    // One binding, two independently recorded results: a failed projection and an applied import.
    expect(
      store.db
        .prepare("SELECT state FROM projection_outbox WHERE binding_id=? AND message_id=?")
        .get(bindingId, messageId),
    ).toEqual({ state: "failed" });
    expect(
      store.db
        .prepare(
          "SELECT count(*) n FROM projection_imports WHERE binding_id=? AND status='applied'",
        )
        .get(bindingId),
    ).toEqual({ n: 1 });
    expect(internalMessage(daemon, "imported answer")).toBe(true);
  },
);
