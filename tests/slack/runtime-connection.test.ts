import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../../src/storage/store.js";
import { configSchema } from "../../src/config.js";
import { configFixture } from "../helpers/config.js";
import { Messages, Output } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { CanonicalAttention } from "../../src/conversations/attention.js";
import { CanonicalFreshnessGate } from "../../src/conversations/freshness.js";
import { Ingress } from "../../src/daemon/ingress.js";
import { Controls } from "../../src/daemon/control.js";
import { CanonicalSlackNormalizer } from "../../src/slack/normalize.js";
import { CanonicalSlackTransport } from "../../src/slack/transport.js";
import { SlackRuntime, type SlackRuntimeOptions } from "../../src/slack/runtime.js";
import { readSlackReadiness } from "../../src/slack/readiness.js";
import { slackSockets } from "../helpers/slack-connection.js";
const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups.splice(0).forEach((fn) => fn());
});
/** Two installations, so one failing teammate is visible as a separate readiness fact. */
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
    },
  ],
};
function setup(options: { runtime?: SlackRuntimeOptions; agents?: unknown } = {}) {
  const config = configSchema.parse(options.agents ?? twoAgents),
    store = new Store(":memory:");
  cleanups.push(() => store.close());
  // Synthetic app tokens: the runtime reads them from the environment, never from a test fixture.
  const refs = ["RESEARCH_APP_TOKEN", "RESEARCH_BOT_TOKEN", "WRITER_APP", "WRITER_BOT"],
    saved = Object.fromEntries(refs.map((ref) => [ref, process.env[ref]]));
  for (const ref of refs) process.env[ref] = "synthetic";
  cleanups.push(() => {
    for (const ref of refs) {
      if (saved[ref] === undefined) delete process.env[ref];
      else process.env[ref] = saved[ref];
    }
  });
  const messages = new Messages(store, config),
    post = vi.fn(async () => ({ ts: "101.000001" })),
    attention = new CanonicalAttention(messages),
    gate = new CanonicalFreshnessGate(messages, attention),
    output = new Output(messages, { post }, Date.now, gate),
    collaboration = new Collaboration(store, messages, output, config, attention),
    transport = new CanonicalSlackTransport(store, messages.mapper, {
      research: "synthetic",
      writer: "synthetic",
    }),
    ingress = new Ingress(
      collaboration,
      new CanonicalSlackNormalizer(messages, messages.mapper, output),
    );
  // The controllable transport seam: real WebClients whose platform answers this test decides.
  for (const agent of config.agents) {
    store.register(agent.id, "v1", []);
    const client = transport.clients.get(agent.id)!;
    client.auth.test = vi.fn(async () => ({
      team_id: config.teamId,
      user_id: agent.slackUserId,
      bot_id: agent.slackBotId,
    })) as never;
    client.bots.info = vi.fn(async () => ({ bot: { app_id: agent.slackAppId } })) as never;
    client.users.conversations = vi.fn(async () => ({ channels: [] })) as never;
    client.conversations.info = vi.fn(async ({ channel }: { channel: string }) => ({
      channel: { id: channel, is_member: true },
    })) as never;
    client.conversations.history = vi.fn(async () => ({ messages: [] })) as never;
  }
  const runtime = new SlackRuntime(
    collaboration,
    transport,
    new Controls(collaboration, {} as never, {} as never),
    () => {},
    undefined,
    { backoff: { baseMs: 1000, maxMs: 8000 }, ...options.runtime },
  );
  cleanups.push(() => void runtime.close());
  return { config, store, collaboration, transport, ingress, runtime };
}
const installation = (runtime: SlackRuntime, agentId: string) =>
  runtime.readiness().installations.find((entry) => entry.agentId === agentId)!;
it("serves the daemon before any connection and reports each installation separately", async () => {
  // The socket never finishes connecting until this test allows it.
  const sockets = slackSockets((socket) => socket.hold()),
    { runtime, transport, store } = setup({ runtime: { socket: sockets.socket } });
  await runtime.start(new AbortController().signal);
  expect(installation(runtime, "research").state).toBe("connecting");
  expect(runtime.readiness().ready).toBe(false);
  expect(transport.readyFor("research")).toBe(false);
  expect(transport.waitingFor("research")?.reason).toContain("still connecting");
  // The persisted record is what an owner view reads while the connection is pending.
  expect(readSlackReadiness(store)).toMatchObject({
    installations: [
      { agentId: "research", state: "connecting" },
      { agentId: "writer", state: "connecting" },
    ],
  });
  sockets.created.forEach((entry) => entry.socket.release());
  await vi.waitFor(() => expect(runtime.readiness().ready).toBe(true));
  expect(transport.readyFor("research")).toBe(true);
  expect(transport.waitingFor("research")).toBeUndefined();
  expect(readSlackReadiness(store)?.installations[0]).toMatchObject({
    state: "ready",
    reason: "connected",
  });
});
it("retries a temporary connection failure with growing waits until the installation is ready", async () => {
  let clock = 1_000_000,
    offline = true;
  const sockets = slackSockets((socket) => {
    if (offline) socket.fail = new Error("network unreachable");
  });
  const { runtime } = setup({
    runtime: { socket: sockets.socket, now: () => clock },
  });
  await runtime.start(new AbortController().signal);
  await vi.waitFor(() =>
    expect(installation(runtime, "research")).toMatchObject({
      state: "waiting",
      reason: "connection_unavailable",
      attempts: 1,
    }),
  );
  const first = installation(runtime, "research").nextAttemptAt!;
  expect(first).toBe(clock + 1000);
  // Not due yet: another poll must not retry densely.
  runtime.poll();
  await Promise.resolve();
  expect(installation(runtime, "research").attempts).toBe(1);
  clock += 1000;
  runtime.poll();
  await vi.waitFor(() =>
    expect(installation(runtime, "research")).toMatchObject({ state: "waiting", attempts: 2 }),
  );
  // The interval grows with each failure and stays bounded by the cap.
  expect(installation(runtime, "research").nextAttemptAt).toBe(clock + 2000);
  offline = false;
  clock += 2000;
  runtime.poll();
  await vi.waitFor(() => expect(installation(runtime, "research").state).toBe("ready"));
  expect(sockets.created.length).toBeGreaterThanOrEqual(3);
  expect(installation(runtime, "research").nextAttemptAt).toBeUndefined();
});
it("reports the operator action for a revoked credential and keeps the healthy installation ready", async () => {
  let clock = 1_000_000;
  const sockets = slackSockets(),
    { runtime, transport, store } = setup({
      runtime: { socket: sockets.socket, now: () => clock },
    });
  transport.clients.get("research")!.auth.test = vi.fn(async () => {
    throw { code: "slack_webapi_platform_error", data: { error: "invalid_auth" } };
  }) as never;
  await runtime.start(new AbortController().signal);
  await vi.waitFor(() => expect(installation(runtime, "research").state).toBe("needs-human"));
  await vi.waitFor(() => expect(runtime.readiness().ready).toBe(false));
  expect(installation(runtime, "research")).toMatchObject({
    reason: "invalid_auth",
    attempts: 1,
  });
  expect(installation(runtime, "research").action).toContain(
    "Replace the Slack tokens of research",
  );
  expect(installation(runtime, "writer").state).toBe("ready");
  expect(transport.readyFor("writer")).toBe(true);
  expect(transport.readyFor("research")).toBe(false);
  expect(transport.readyAgents()).toEqual(["writer"]);
  // No automatic retry can replace a credential, and no Agent is paused for it.
  clock += 3600_000;
  runtime.poll();
  await Promise.resolve();
  expect(installation(runtime, "research").attempts).toBe(1);
  expect(store.db.prepare("SELECT count(*) n FROM agents WHERE paused=1").get()).toEqual({ n: 0 });
  expect(store.db.prepare("SELECT count(*) n FROM runs WHERE state='failed'").get()).toEqual({
    n: 0,
  });
});
it("treats a dropped socket as not ready and reconnects it through a fresh attempt", async () => {
  let clock = 1_000_000;
  const sockets = slackSockets(),
    { runtime, transport, store } = setup({
      runtime: { socket: sockets.socket, now: () => clock },
    });
  await runtime.start(new AbortController().signal);
  await vi.waitFor(() => expect(runtime.readiness().ready).toBe(true));
  const connected = sockets.created.length;
  sockets.forAgent("research")!.drop();
  await vi.waitFor(() => expect(installation(runtime, "research").state).toBe("waiting"));
  expect(installation(runtime, "research").reason).toBe("transport_gap");
  expect(transport.readyFor("research")).toBe(false);
  // The gap is recorded, so a message deleted while the socket was down is never assumed intact.
  expect(
    store.db
      .prepare("SELECT count(*) n FROM audit WHERE kind='slack_offline_delete_gap_fenced'")
      .get(),
  ).toEqual({ n: 1 });
  clock += 1000;
  runtime.poll();
  await vi.waitFor(() => expect(runtime.readiness().ready).toBe(true));
  expect(sockets.created.length).toBeGreaterThan(connected);
  expect(installation(runtime, "research").state).toBe("ready");
});

it("does not claim ready when the socket drops during its own catch-up attempt", async () => {
  let clock = 1_000_000;
  const sockets = slackSockets(),
    { runtime, transport } = setup({
      agents: configFixture,
      runtime: { socket: sockets.socket, now: () => clock },
    }),
    client = transport.clients.get("research")!;
  // Hold the history catch-up so the drop lands while this attempt is still running.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  client.conversations.history = vi.fn(async () => {
    await held;
    return { messages: [] };
  }) as never;
  await runtime.start(new AbortController().signal);
  await vi.waitFor(() => expect(sockets.forAgent("research")).toBeDefined());
  sockets.forAgent("research")!.drop();
  await vi.waitFor(() => expect(installation(runtime, "research").state).toBe("waiting"));
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The attempt that finished belongs to a socket that is already gone: it must not report ready,
  // or the scheduled reconnect would be skipped for good and Slack ingress would stay dead.
  expect(installation(runtime, "research")).toMatchObject({ state: "waiting" });
  expect(transport.readyFor("research")).toBe(false);
  clock += 1000;
  runtime.poll();
  await vi.waitFor(() => expect(runtime.readiness().ready).toBe(true), { timeout: 5000 });
  expect(sockets.created.filter((entry) => entry.agentId === "research")).toHaveLength(2);
});
