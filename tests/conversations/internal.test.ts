import { buildBaseline } from "../../src/runtime/prompt.js";
import { operationDocumentation } from "../../src/runtime/tools.js";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/storage/store.js";
import { localApplication } from "../../src/local/application.js";
import type { TeamSettings } from "../../src/domain/agents.js";
import { Broker } from "../../src/policy/broker.js";
import { ToolRouter } from "../../src/runtime/tools.js";
import { Supervisor } from "../../src/runtime/supervisor.js";
import { TeamDirectory } from "../../src/conversations/team-directory.js";
const settings: TeamSettings = {
  agents: ["alice", "bob", "outsider"].map((id) => ({
    id,
    name: id,
    role: "colleague",
    model: { provider: "test", id: "test", apiKeyEnv: "TEST_KEY" },
  })),
  ownerUserIds: ["local-owner"],
  runTimeoutMs: 10000,
};
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function setup(path = ":memory:") {
  const s = new Store(path);
  cleanup.push(() => s.close());
  const app = localApplication(s, settings);
  for (const a of settings.agents)
    s.register(
      a.id,
      buildBaseline(a, operationDocumentation).configVersion,
      buildBaseline(a, operationDocumentation).messages,
    );
  const run = (actor: string) => {
    s.enqueue(actor, "start", {});
    const r = s.beginRun(actor)!;
    s.input(r, {});
    return r;
  };
  return { s, ...app, run };
}
const signal = new AbortController().signal;
it("opens one durable peer DM, commits work-bound delivery and never calls an external transport", async () => {
  const f = setup(),
    a = f.run("alice"),
    b = f.run("bob");
  const dm = (await f.directory.openDM(a, "a-open", { kind: "agent", id: "bob" }, signal)) as {
    conversationId: string;
  };
  expect(await f.directory.openDM(b, "b-open", { kind: "agent", id: "alice" }, signal)).toEqual(dm);
  expect(await f.directory.openDM(a, "a-open", { kind: "agent", id: "bob" }, signal)).toEqual(dm);
  await expect(
    f.directory.openDM(a, "a-open", { kind: "agent", id: "outsider" }, signal),
  ).rejects.toThrow("identity conflict");
  const work = f.collaboration.createWork("activity", dm),
    post = vi.spyOn(f.output.transport, "post"),
    pending = vi.spyOn(f.output.transport, "pendingInput");
  f.collaboration.send("alice", work, dm, "hello", "send", { run: a });
  const draft = f.output.gate!.describe("alice", "send") as { revision: number; holdId: string };
  f.output.gate!.continueOnce(a, "send", draft.revision, draft.holdId);
  await f.output.send("send");
  await f.output.send("send");
  expect(post).not.toHaveBeenCalled();
  expect(pending).not.toHaveBeenCalled();
  expect(f.s.output("send")?.state).toBe("sent");
  expect(f.messages.read("bob", dm)).toHaveLength(1);
  expect(
    f.s.db
      .prepare(
        "SELECT count(*) n FROM deliveries d JOIN delivery_work w ON w.delivery_id=d.id WHERE d.agent_id='bob' AND w.work_id=?",
      )
      .get(work),
  ).toEqual({ n: 1 });
  expect(() => f.messages.read("outsider", dm)).toThrow("access denied");
  expect((await f.directory.spaces("outsider")).spaces).toEqual([]);
  f.messages.membership("bob", dm.conversationId, false);
  await expect(
    f.directory.openDM(a, "a-open", { kind: "agent", id: "bob" }, signal),
  ).rejects.toThrow("access denied");
  await expect(
    f.directory.openDM(a, "new-open", { kind: "agent", id: "bob" }, signal),
  ).rejects.toThrow("access denied");
});
it("member view and peer DM creation answer under the acting Agent's current access", async () => {
  const f = setup(),
    a = f.run("alice"),
    dm = (await f.directory.openDM(a, "a-open", { kind: "agent", id: "bob" }, signal)) as {
      conversationId: string;
    };
  const work = f.collaboration.createWork("member-view", dm);
  f.collaboration.enqueue("alice", work, "member-view", {});
  const router = new ToolRouter(
      f.collaboration,
      new Broker(
        f.s,
        f.collaboration,
        { execute: async () => ({ code: 0, stdout: "", stderr: "", truncated: false }) },
        {},
      ),
      undefined,
      f.directory,
    ),
    call = (operation: string, input: unknown) =>
      router.call(a, work, operation, operation, input, signal),
    members = async (conversationId: string) =>
      ((await call("conversations.members", { conversationId })).value as any).members
        .map((member: any) => member.id)
        .sort();
  expect(await members(dm.conversationId)).toEqual(["alice", "bob"]);
  await expect(
    call("conversations.openDM", { principal: { kind: "agent", id: "bob" } }),
  ).resolves.toHaveProperty("value");
  f.messages.membership("bob", dm.conversationId, false);
  expect(await members(dm.conversationId)).toEqual(["alice"]);
  f.messages.membership("alice", dm.conversationId, false);
  await expect(
    call("conversations.members", { conversationId: dm.conversationId }),
  ).rejects.toThrow("access denied");
  await expect(
    call("conversations.openDM", { principal: { kind: "agent", id: "bob" } }),
  ).rejects.toThrow("access denied");
});
it("rolls back an interrupted internal commit and retries once after reopening", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mate-internal-"));
  cleanup.unshift(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  const f = setup(path),
    run = f.run("alice"),
    dm = (await f.directory.openDM(run, "open", { kind: "agent", id: "bob" }, signal)) as {
      conversationId: string;
    };
  const work = f.collaboration.createWork("activity", dm);
  f.collaboration.send("alice", work, dm, "durable", "send", { run });
  const draft = f.output.gate!.describe("alice", "send") as { revision: number; holdId: string };
  f.output.gate!.continueOnce(run, "send", draft.revision, draft.holdId);
  f.s.db.exec(
    "CREATE TRIGGER fail_delivery BEFORE INSERT ON delivery_work BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
  );
  await expect(f.output.send("send")).rejects.toThrow("injected failure");
  expect(f.s.output("send")?.state).toBe("pending");
  expect(f.messages.read("bob", dm)).toEqual([]);
  f.s.db.exec("DROP TRIGGER fail_delivery");
  await f.output.send("send");
  const receipt = f.s.output("send")?.receipt;
  f.s.close();
  cleanup.pop();
  const second = setup(path);
  await second.output.send("send");
  expect(second.s.output("send")?.receipt).toBe(receipt);
  expect(second.messages.read("bob", dm)).toHaveLength(1);
  expect(
    second.s.db.prepare("SELECT count(*) n FROM deliveries WHERE agent_id='bob'").get(),
  ).toEqual({ n: 1 });
  expect(() => second.collaboration.send("alice", work, dm, "changed", "send")).toThrow(
    "identity conflict",
  );
});
it("local human input uses the real Supervisor and isolated Agent sessions without Slack configuration", async () => {
  const f = setup(),
    room = f.local!.createRoom("opaque-local-room", ["alice", "bob"], ["local-owner"]);
  const input = f.local!.receive("local-owner", "human-1", room, "please investigate");
  expect(f.local!.receive("local-owner", "human-1", room, "please investigate")).toEqual(input);
  expect(() => f.local!.receive("local-owner", "human-1", room, "different")).toThrow(
    "identity conflict",
  );
  expect(() => f.local!.receive("intruder", "bad", room, "attack")).toThrow("Unknown local human");
  const broker = new Broker(
    f.s,
    f.collaboration,
    { execute: async () => ({ code: 0, stdout: "", stderr: "", truncated: false }) },
    {},
  );
  const router = new ToolRouter(f.collaboration, broker, undefined, f.directory),
    seen: string[] = [];
  const supervisor = new Supervisor(f.collaboration, router, settings, () => ({
    close() {},
    async run(spec) {
      seen.push(JSON.stringify(spec));
      return { tokens: 7, cost: 0.01, certain: true, waiting: false, continuation: false };
    },
  }));
  cleanup.push(() => supervisor.close());
  supervisor.register();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 21000);
  try {
    await supervisor.step("alice");
    await supervisor.step("bob");
  } finally {
    vi.useRealTimers();
  }
  expect(seen).toHaveLength(2);
  expect(f.messages.message("alice", input.messageId).text).toBe("please investigate");
  expect(
    (f.s.db.prepare("SELECT count(*) n FROM runs WHERE state='complete'").get() as { n: number }).n,
  ).toBe(2);
});
it("routes persisted external DM actions back to their original adapter", async () => {
  const f = setup(),
    run = f.run("alice");
  f.messages.writes.prepareAction(run, "old", {
    operation: "conversations.openDM",
    principal: { kind: "agent", id: "bob" },
  });
  const openDM = vi.fn(async () => ({ conversationId: "original-external" }));
  const directory = new TeamDirectory(f.messages, {
    spaces: async () => ({ spaces: [], coverage: [] }),
    members: async () => ({ members: [], incomplete: false }),
    openDM,
  });
  expect(await directory.openDM(run, "old", { kind: "agent", id: "bob" }, signal)).toEqual({
    conversationId: "original-external",
  });
  expect(openDM).toHaveBeenCalledOnce();
  expect(f.s.db.prepare("SELECT count(*) n FROM internal_dm_pairs").get()).toEqual({ n: 0 });
});
it("preserves review-seat isolation when a peer sends an internal DM before restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mate-seat-"));
  cleanup.unshift(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  const f = setup(path),
    run = f.run("alice"),
    dm = (await f.directory.openDM(run, "open", { kind: "agent", id: "bob" }, signal)) as {
      conversationId: string;
    };
  f.collaboration.seats.activate(
    "local-owner",
    "bob",
    dm,
    "independent brief",
    () => "/synthetic-clean-workspace",
  );
  const work = f.collaboration.createWork("activity", dm);
  f.collaboration.send("alice", work, dm, "PRIVATE_PEER_ARGUMENT", "send", { run });
  const draft = f.output.gate!.describe("alice", "send") as { revision: number; holdId: string };
  f.output.gate!.continueOnce(run, "send", draft.revision, draft.holdId);
  await f.output.send("send");
  f.s.close();
  cleanup.pop();
  const second = setup(path);
  expect(() => second.messages.read("bob", dm)).toThrow("isolates");
  await expect(second.directory.members("bob", dm.conversationId)).rejects.toThrow("isolates");
  const broker = new Broker(
    second.s,
    second.collaboration,
    { execute: async () => ({ code: 0, stdout: "", stderr: "", truncated: false }) },
    {},
  );
  const router = new ToolRouter(second.collaboration, broker, undefined, second.directory);
  let observed = "";
  const supervisor = new Supervisor(second.collaboration, router, settings, () => ({
    close() {},
    async run(spec) {
      observed = JSON.stringify(spec);
      return { tokens: 1, cost: 0, certain: true, waiting: false, continuation: false };
    },
  }));
  cleanup.push(() => supervisor.close());
  supervisor.register();
  expect(await supervisor.step("bob")).toBe(true);
  expect(observed).toContain("independent brief");
  expect(observed).not.toContain("PRIVATE_PEER_ARGUMENT");
  expect(
    (
      second.s.db
        .prepare("SELECT count(*) n FROM runs WHERE agent_id='bob' AND state='complete'")
        .get() as { n: number }
    ).n,
  ).toBe(1);
});
it("Slack background membership and history never pass internal identifiers to its mapper", async () => {
  const { SlackService } = await import("../../src/slack/service.js");
  const f = setup(),
    run = f.run("alice");
  const dm = (await f.directory.openDM(run, "open", { kind: "agent", id: "bob" }, signal)) as {
    conversationId: string;
  };
  f.messages.references.createMessage(dm.conversationId, "opaque-root");
  f.messages.watch("alice", { ...dm, threadId: "opaque-root" }, true);
  const target = vi.fn(() => {
    throw new Error("internal identifier reached Slack");
  });
  const transport = {
    mapper: {
      config: { teamId: "TEST", agents: settings.agents.map((a) => ({ ...a, channels: {} })) },
      target,
    },
    clients: new Map(settings.agents.map((a) => [a.id, {}])),
  };
  const slack = new SlackService(f.collaboration, transport as any, {} as any, {} as any);
  await slack.membership();
  await slack.catchUp();
  expect(target).not.toHaveBeenCalled();
  expect(f.messages.access("alice", dm.conversationId)).toBe(true);
});
it("rejects unsupported internal artifact/projection before recording a send intent", async () => {
  const f = setup(),
    run = f.run("alice"),
    dm = (await f.directory.openDM(run, "open", { kind: "agent", id: "bob" }, signal)) as {
      conversationId: string;
    };
  expect(() =>
    f.output.queueArtifact("alice", dm, "caption", {} as any, "artifact", { run }),
  ).toThrow("not supported");
  expect(f.s.output("artifact")).toBeUndefined();
  f.messages.references.bindConversation(
    { provider: "test", workspace: "test", externalId: "display" },
    dm.conversationId,
    "projection",
  );
  expect(() => f.output.queue("alice", dm, "body", "projected", { run })).toThrow("projection");
  expect(f.s.output("projected")).toBeUndefined();
});

it("revision cannot smuggle unsupported artifacts into an internal target", async () => {
  const f = setup(),
    run = f.run("alice"),
    dm = (await f.directory.openDM(run, "open", { kind: "agent", id: "bob" }, signal)) as {
      conversationId: string;
    };
  f.messages.references.createConversation("channel", "external", "external");
  f.messages.membership("alice", "external", true);
  vi.spyOn(f.messages, "requirePublication").mockImplementation(() => {}); // Explicit synthetic external capability for this revision test.
  f.output.queueArtifact(
    "alice",
    { conversationId: "external" },
    "caption",
    {} as any,
    "artifact",
    { run },
  );
  expect(() => f.output.gate!.revise(run, "artifact", 1, "caption", dm)).toThrow("not supported");
  expect(f.s.output("artifact")?.state).toBe("held");
  expect(f.s.output("artifact:revision:2")).toBeUndefined();
});
it("retains local human input under a paused activity without starting a run", () => {
  const f = setup(),
    room = f.local!.createRoom("room", ["alice"], ["local-owner"]);
  const root = f.local!.receive("local-owner", "root", room, "start");
  const work = f.s.db
    .prepare("SELECT work_id FROM message_work WHERE message_key=?")
    .get(root.messageId) as { work_id: string };
  f.s.db.prepare("UPDATE works SET state='paused' WHERE id=?").run(work.work_id);
  const reply = f.local!.receive(
    "local-owner",
    "steering",
    { ...room, threadId: root.messageId },
    "new information",
  );
  expect(f.messages.message("alice", reply.messageId).text).toBe("new information");
  expect(f.s.beginRun("alice", Date.now() + 21000, true)).toBeUndefined();
});
