import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../../src/application.js";
import { Daemon } from "../../src/daemon/app.js";
import { localApplication } from "../../src/local/application.js";
import { Store } from "../../src/storage/store.js";
import { acquireLock } from "../../src/daemon/lock.js";
import { daemonFixture } from "../helpers/daemon-config.js";
import { configFixture } from "../helpers/config.js";
import type { TeamSettings } from "../../src/domain/agents.js";
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
/** A deployment configuration that serves Slack and one local room. */
function deployment() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-assembly-"))),
    data = join(root, "data");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const config = daemonFixture(
    data,
    {
      ...configFixture,
      agents: [
        {
          ...configFixture.agents[0],
          model: { provider: "anthropic", id: "claude-haiku-4-5", apiKeyEnv: "MODEL_API_KEY" },
        },
      ],
    },
    { researchHosts: [] },
  );
  config.adapters.local = {
    humans: ["owner"],
    rooms: [{ id: "local-room", agents: ["research"], humans: ["owner"] }],
  };
  return { root, data, config };
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
/** An active run owning the work this test publishes output for. */
function openRun(daemon: Daemon, target: { conversationId: string }) {
  const work = daemon.collaboration.createWork("assembly", target);
  daemon.collaboration.enqueue("research", work, "start", {});
  const run = daemon.store.beginRun("research")!;
  daemon.store.input(run, {});
  return { work, run };
}
/** Queue an external output and confirm its freshness basis, as a tool call would. */
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
  return id;
}
/** Remote success evidence from the real Slack mapper, without touching the network. */
function confirmingPost(transport: CanonicalSlackTransport) {
  let seq = 0;
  return vi.spyOn(transport, "post").mockImplementation(async (request) => {
    const external = transport.mapper.target(request.target),
      agent = transport.mapper.config.agents.find((a) => a.id === request.actor)!,
      ts = `300.${String(++seq).padStart(6, "0")}`;
    return {
      message: transport.mapper.message({
        ...external,
        ts,
        revision: ts,
        text: request.text,
        user: agent.slackUserId,
        bot: agent.slackBotId,
        deleted: false,
      }),
      receipt: { ts },
    };
  });
}
const settings: TeamSettings = {
  agents: [
    {
      id: "research",
      name: "Research",
      role: "colleague",
      model: { provider: "test", id: "test", apiKeyEnv: "TEST_KEY" },
    },
  ],
  ownerUserIds: ["owner"],
  runTimeoutMs: 10000,
};
it("gives the daemon and the local entry the same assembled application with nothing left to install", async () => {
  credentials();
  const { config } = deployment(),
    daemon = await Daemon.create(config, log);
  cleanups.push(() => daemon.close());
  // The real (database-backed) local entry, assembled by the same Application.create.
  const store = new Store(":memory:"),
    local = localApplication(store, settings);
  cleanups.push(() => store.close());
  for (const [entry, application] of [
    ["daemon", daemon.application],
    ["local", local],
  ] as const) {
    expect(application, entry).toBeInstanceOf(Application);
    // The one attention instance and the one freshness gate are wired at construction: the
    // output, the tool router and the collaboration all use them without a later installation.
    expect(application.collaboration.attention, entry).toBe(application.attention);
    expect(application.output.gate, entry).toBe(application.gate);
    expect(application.router.gate, entry).toBe(application.gate);
    // Every collaborator an entry calls is already connected to the same application.
    expect(application.supervisor.router, entry).toBe(application.router);
    expect(application.controls.collaboration, entry).toBe(application.collaboration);
    expect(application.controls.supervisor, entry).toBe(application.supervisor);
    expect(application.broker.collaboration, entry).toBe(application.collaboration);
    expect(application.system.collaboration, entry).toBe(application.collaboration);
    expect(application.artifacts.collaboration, entry).toBe(application.collaboration);
    expect(application.directory.messages, entry).toBe(application.messages);
    expect(application.messages.writes, entry).toBeDefined();
    expect(application.local, entry).toBeDefined();
  }
  expect(daemon.application.transport).toBeDefined();
  expect(local.transport).toBeUndefined();
});
it("stops intake, stops advancing work, collects workers, records the unconfirmed effect, then releases the database and the lock", async () => {
  credentials();
  const { config, data } = deployment(),
    daemon = await Daemon.create(config, log);
  const target = externalTarget(daemon),
    { work, run } = openRun(daemon, target),
    transport = daemon.application.transport!;
  const order: string[] = [];
  // An external effect whose outcome this process cannot confirm: the request never returns.
  vi.spyOn(transport, "post").mockImplementation(() => new Promise(() => {}));
  const id = queueExternal(daemon, work, run, "unconfirmed", "sent before shutdown");
  const sending = daemon.collaboration.output.send(id).catch(() => {});
  await vi.waitFor(() => expect(daemon.store.output(id)!.state).toBe("sending"));
  // A broker action inside its execution boundary at shutdown is equally unconfirmable.
  daemon.store.prepareAction(run as never, `${run.id}:action-1`, { kind: "exec", args: [] });
  daemon.store.startAction(run as never, `${run.id}:action-1`);
  Object.defineProperty(daemon, "adapter", {
    value: {
      start: async () => {},
      recover() {},
      poll() {},
      flush: async () => {},
      close: async () => {
        order.push("intake.close");
      },
    },
  });
  const closeWorkers = daemon.supervisor.close.bind(daemon.supervisor);
  vi.spyOn(daemon.supervisor, "close").mockImplementation(() => {
    order.push("work.stop");
    closeWorkers();
  });
  vi.spyOn(daemon.supervisor, "drain").mockImplementation(async () => {
    order.push("work.drain");
  });
  const fence = daemon.application.fenceUnconfirmedEffects.bind(daemon.application);
  vi.spyOn(daemon.application, "fenceUnconfirmedEffects").mockImplementation(() => {
    order.push("effects.fence");
    fence();
  });
  const closeStore = daemon.store.close.bind(daemon.store);
  let stateAtRelease: string | undefined,
    actionAtRelease: string | undefined,
    lockHeldAtRelease = false;
  vi.spyOn(daemon.store, "close").mockImplementation(() => {
    order.push("database.close");
    stateAtRelease = (
      daemon.store.db.prepare("SELECT state FROM outbox WHERE id=?").get(id) as { state: string }
    ).state;
    actionAtRelease = (
      daemon.store.db.prepare("SELECT state FROM actions WHERE id=?").get(`${run.id}:action-1`) as {
        state: string;
      }
    ).state;
    try {
      acquireLock(join(data, "state", "daemon.lock"))();
    } catch {
      lockHeldAtRelease = true;
    }
    closeStore();
  });
  await daemon.close();
  sending.catch(() => {});
  expect(order).toEqual([
    "intake.close",
    "work.stop",
    "work.drain",
    "effects.fence",
    "database.close",
  ]);
  // Unconfirmed external effects are persistent unknown results before the database is gone.
  expect(stateAtRelease).toBe("unknown");
  expect(actionAtRelease).toBe("unknown");
  expect(lockHeldAtRelease).toBe(true);
  const release = acquireLock(join(data, "state", "daemon.lock"));
  release();
});
it("does not repeat a confirmed external operation after a restart and keeps internal state recoverable", async () => {
  credentials();
  const { config, data } = deployment(),
    first = await Daemon.create(config, log);
  const target = externalTarget(first),
    { work, run } = openRun(first, target),
    posted = confirmingPost(first.application.transport!),
    outbox = queueExternal(first, work, run, "confirmed", "delivered once");
  // Internal message, task, delivery and session this restart must keep.
  first.local!.receive("owner", "internal-1", { conversationId: "local-room" }, "kept history");
  const internalWork = first.collaboration.createWork("keep", { conversationId: "local-room" }),
    delivery = first.collaboration.enqueue("research", internalWork, "kept", { text: "keep" }),
    task = first.collaboration.createTask(
      "research",
      internalWork,
      { conversationId: "local-room" },
      "kept task",
    ),
    session = first.store.db.prepare("SELECT session_id FROM agents WHERE id='research'").get();
  await first.collaboration.output.send(outbox);
  expect(posted).toHaveBeenCalledOnce();
  expect(first.store.output(outbox)!.state).toBe("sent");
  await first.close();
  const second = await Daemon.create(config, log);
  cleanups.push(() => second.close());
  const reposted = vi.spyOn(second.application.transport!, "post"),
    tick = vi.spyOn(second.collaboration, "tick");
  Object.defineProperty(second, "adapter", {
    value: {
      start: async () => {},
      recover() {},
      poll() {},
      flush: async () => {},
      close: async () => {},
    },
  });
  await second.start();
  await vi.waitFor(() => expect(tick).toHaveBeenCalled());
  expect(reposted).not.toHaveBeenCalled();
  expect(second.store.output(outbox)!.state).toBe("sent");
  expect(second.collaboration.output.ready(20, "external")).toEqual([]);
  expect(
    second.local!.read("owner", { conversationId: "local-room" }).messages.map((m) => m.text),
  ).toContain("kept history");
  expect(second.store.delivery(delivery).status).toBe("pending");
  expect(second.store.db.prepare("SELECT title,status FROM tasks WHERE id=?").get(task)).toEqual({
    title: "kept task",
    status: "todo",
  });
  expect(
    second.store.db.prepare("SELECT session_id FROM agents WHERE id='research'").get(),
  ).toEqual(session);
});
