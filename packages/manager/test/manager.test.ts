import { AgentRuntime, createAgentStore, readAgentState } from "@mate/runtime";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { AgentCreationFailed, AgentIdInUse } from "../src/index.ts";
import { environment, nodeId, notices, settings, settle, text } from "./support.ts";

const agentFiles = (directory: string) =>
  readdirSync(directory).filter((name) => name.endsWith(".sqlite"));

describe("creating an Agent", () => {
  it("gives a new Agent a chat account, a prepared workspace, a store file, and an open runtime", async () => {
    const env = await environment();
    const manager = await env.open();

    const agentId = await manager.create({
      displayName: "Richard",
      handle: "richard",
      settings,
      nodeId,
    });

    expect(env.chat.findAccount(agentId), "the chat account exists").toBeDefined();
    expect(env.workspaces.prepared.get(agentId), "the workspace was prepared on the node").toBe(
      nodeId,
    );
    expect(agentFiles(env.directory), "one store file named by the Agent ID").toEqual([
      `${agentId}.sqlite`,
    ]);
    expect(manager.list()).toEqual([{ agentId, open: true }]);
    expect(manager.runtime(agentId), "the runtime is open").toBeDefined();
  });

  it("finishes the same Agent when a create that failed at any step is run again with its agentId", async () => {
    const env = await environment();
    const manager = await env.open();
    // Refused at the chat account: the handle belongs to someone else. Nothing exists yet, so it is no create to finish.
    env.chat.ensureAccount({
      externalId: "someone",
      displayName: "Lin",
      handle: "lin",
      kind: "agent",
    });
    await expect(
      manager.create({ displayName: "Lin", handle: "lin", settings, nodeId }),
    ).rejects.toMatchObject({ reason: "handle-taken" });
    expect(manager.list(), "no Agent before the store is in place").toEqual([]);

    // Fails at the workspace, after the chat account was made.
    const agentId = randomUUID();
    env.workspaces.beforeNextPrepare = () => {
      throw new Error("node offline");
    };
    await expect(
      manager.create({ agentId, displayName: "Lin", handle: "lin2", settings, nodeId }),
    ).rejects.toBeInstanceOf(AgentCreationFailed);
    const account = env.chat.findAccount(agentId);
    expect(account, "the account was made before the failure").toBeDefined();
    expect(manager.list(), "still no Agent").toEqual([]);

    // The workspace was made, then the process died before the store.
    env.workspaces.beforeNextPrepare = () => {
      throw new Error("died after the workspace was made");
    };
    await expect(
      manager.create({ agentId, displayName: "Lin", handle: "lin2", settings, nodeId }),
    ).rejects.toBeInstanceOf(AgentCreationFailed);

    expect(
      await manager.create({ agentId, displayName: "Lin", handle: "lin2", settings, nodeId }),
      "the rerun finishes the same Agent",
    ).toBe(agentId);
    // The Agent exists now: a further rerun is refused, not repeated.
    await expect(
      manager.create({ agentId, displayName: "Lin", handle: "lin2", settings, nodeId }),
    ).rejects.toBeInstanceOf(AgentIdInUse);

    expect(env.chat.findAccount(agentId), "the same account throughout").toBe(account);
    expect(agentFiles(env.directory), "one file").toEqual([`${agentId}.sqlite`]);
    expect(manager.list()).toEqual([{ agentId, open: true }]);
  });

  it("refuses to create with the ID of an Agent that exists, paused or not, or that was deleted, and changes nothing", async () => {
    const env = await environment();
    const manager = await env.open();
    const agentId = await manager.create({ displayName: "Lin", handle: "lin", settings, nodeId });
    const names = () => env.chat.liveSnapshot(env.owner).accounts.map((account) => account.handle);
    const again = (handle: string) =>
      manager.create({ agentId, displayName: "Other", handle, settings, nodeId });

    await expect(again("other"), "an open Agent").rejects.toBeInstanceOf(AgentIdInUse);
    await manager.pause(agentId);
    await expect(again("other"), "a paused Agent").rejects.toBeInstanceOf(AgentIdInUse);
    expect(names(), "the Agent was not renamed").toEqual(["owner", "lin"]);
    expect((await manager.describe(agentId)).state, "and is still paused").toBe("paused");

    await manager.delete(agentId);
    await expect(again("other"), "a deleted Agent").rejects.toMatchObject({
      reason: "inactive-account",
    });
    expect(manager.list(), "not brought back").toEqual([]);
    expect(names(), "nor renamed").toEqual(["owner", "lin"]);
  });

  it("keeps an Agent whose runtime fails to open right after the store was put in place, closed and reported", async () => {
    const env = await environment();
    const manager = await env.open();
    const agentId = randomUUID();
    env.workspaces.onOpen = () => {
      throw new Error("cannot open");
    };

    expect(
      await manager.create({ agentId, displayName: "Lin", handle: "lin", settings, nodeId }),
      "the Agent exists, so the create is done",
    ).toBe(agentId);
    expect(env.reports.map((report) => report.agentId)).toEqual([agentId]);
    expect(manager.list()).toEqual([{ agentId, open: false }]);

    env.workspaces.onOpen = undefined;
    await manager.resume(agentId);
    expect(manager.list(), "resume opens it").toEqual([{ agentId, open: true }]);
  });

  it("does not see an Agent whose store was never renamed into place, and a rerun finishes it", async () => {
    const env = await environment();
    const agentId = randomUUID();
    env.chat.ensureAccount({
      externalId: agentId,
      displayName: "Lin",
      handle: "lin",
      kind: "agent",
    });
    // A complete store under the temporary name: the process died just before the rename.
    const staged = join(env.directory, `${agentId}.sqlite`);
    await createAgentStore(staged, { nodeId, settings });
    renameSync(staged, `${staged}.creating`);

    const manager = await env.open();
    expect(manager.list(), "the temporary file is not an Agent").toEqual([]);
    expect(manager.runtime(agentId)).toBeUndefined();
    expect(env.reports, "nothing to report").toEqual([]);

    await manager.create({ agentId, displayName: "Lin", handle: "lin", settings, nodeId });
    expect(manager.list()).toEqual([{ agentId, open: true }]);
    expect(agentFiles(env.directory)).toEqual([`${agentId}.sqlite`]);
  });
});

describe("the node an Agent is on", () => {
  it("prepares the Agent's workspace on the chosen node and runs its workspace tools there", async () => {
    const env = await environment();
    const manager = await env.open();
    const { agentId, account } = await env.hire(manager, { nodeId: "node-b" });
    env.workspaces.workspace(agentId, "node-b").answerAll(() => text("built"));
    env.provider
      .step(
        "build",
        (request) => void request.call([{ name: "bash", arguments: { command: "make" } }]),
      )
      .step("done", (request) => {
        expect(request.toolOutputs().join(), "the chosen node answered").toContain("built");
        request.text("built it");
      });

    env.post("Build it, @richard.", { mentions: [account] });
    await env.provider.received(2);
    await manager.runtime(agentId)?.idle();

    expect(env.workspaces.prepared.get(agentId), "the workspace is on the chosen node").toBe(
      "node-b",
    );
    expect(env.workspaces.workspace(agentId, "node-b").calls, "the call ran there").toHaveLength(1);
    expect(env.workspaces.workspace(agentId, nodeId).calls, "and nowhere else").toEqual([]);
    expect((await manager.describe(agentId)).nodeId).toBe("node-b");
    env.provider.assertComplete();
  });

  it("opens the Agent on the node recorded at its creation, after a restart and after a resume", async () => {
    const env = await environment();
    const first = await env.open();
    const agentId = await first.create({
      displayName: "Richard",
      handle: "richard",
      settings,
      nodeId: "node-b",
    });
    await first.close();

    const second = await env.open();
    await second.pause(agentId);
    await second.resume(agentId);

    expect(
      env.workspaces.ports.filter((port) => port.agentId === agentId).map((port) => port.nodeId),
      "created, restarted and resumed, always on its node",
    ).toEqual(["node-b", "node-b", "node-b"]);
  });
});

describe("describing and configuring an Agent", () => {
  it("describes an Agent the same way whether it is open, paused or closed", async () => {
    const env = await environment();
    const manager = await env.open();
    const { agentId, account } = await env.hire(manager);
    env.provider.step("notice", (request) => request.text("seen", { inputTokens: 70 }));
    env.post("Morning, @richard.", { mentions: [account] });
    await env.provider.received(1);
    await manager.runtime(agentId)?.idle();

    const open = await manager.describe(agentId);
    expect(open).toMatchObject({ agentId, nodeId, state: "open", settings });
    expect(open.usage.models["openai/gpt-4.1"], "the usage so far").toMatchObject({ input: 70 });

    await manager.pause(agentId);
    expect(await manager.describe(agentId), "paused, with the same facts").toEqual({
      ...open,
      state: "paused",
    });
    env.provider.assertComplete();
  });

  it("changes a paused Agent's settings, and its first request after resuming uses them", async () => {
    const env = await environment();
    const manager = await env.open();
    const { agentId, account } = await env.hire(manager);
    await manager.pause(agentId);
    const changed = { model: { provider: "openai", modelId: "gpt-4.1-mini" } };

    await manager.configure(agentId, changed);
    env.post("Morning, @richard.", { mentions: [account] });
    env.provider.step("resumed", (request) => {
      expect(request.body.model, "the settings changed while paused").toBe("gpt-4.1-mini");
      request.text("seen");
    });
    await manager.resume(agentId);
    await env.provider.received(1);
    await manager.runtime(agentId)?.idle();

    expect((await manager.describe(agentId)).settings).toEqual(changed);
    env.provider.assertComplete();
  });
});

describe("restarting", () => {
  it("opens every Agent that is not paused, and keeps a paused one closed", async () => {
    const env = await environment();
    const first = await env.open();
    const working = await first.create({
      displayName: "Richard",
      handle: "richard",
      settings,
      nodeId,
    });
    const paused = await first.create({ displayName: "Lin", handle: "lin", settings, nodeId });
    await first.pause(paused);
    await first.close();

    const second = await env.open();

    expect(second.runtime(working), "the unpaused Agent is open").toBeDefined();
    expect(second.runtime(paused), "the paused Agent stays closed").toBeUndefined();
    expect(second.list().sort((a, b) => a.agentId.localeCompare(b.agentId))).toEqual(
      [
        { agentId: working, open: true },
        { agentId: paused, open: false },
      ].sort((a, b) => a.agentId.localeCompare(b.agentId)),
    );
  });

  it("keeps an Agent paused across a restart until it is resumed", async () => {
    const env = await environment();
    const first = await env.open();
    const agentId = await first.create({
      displayName: "Richard",
      handle: "richard",
      settings,
      nodeId,
    });
    await first.pause(agentId);
    await first.close();

    const second = await env.open();
    expect(second.runtime(agentId), "still paused after the restart").toBeUndefined();
    await second.resume(agentId);
    expect(second.runtime(agentId), "open once resumed").toBeDefined();
    await second.close();

    const third = await env.open();
    expect(third.runtime(agentId), "a resumed Agent opens on the next restart").toBeDefined();
  });

  it("reports an Agent whose file is corrupt and opens and runs the others", async () => {
    const env = await environment();
    const first = await env.open();
    const { agentId, account } = await env.hire(first);
    await first.close();
    const corrupt = randomUUID();
    writeFileSync(join(env.directory, `${corrupt}.sqlite`), "this is not a database");

    const second = await env.open();

    expect(
      env.reports.map((report) => report.agentId),
      "the corrupt Agent is reported",
    ).toEqual([corrupt]);
    expect(second.runtime(corrupt)).toBeUndefined();
    expect(second.runtime(agentId), "the healthy Agent is open").toBeDefined();
    const answered = Promise.withResolvers<void>();
    env.provider.step("notice", (request) => {
      expect(notices(request.userTexts()), "the healthy Agent is notified").toHaveLength(1);
      request.text("seen");
      answered.resolve();
    });
    env.post("Morning, @richard.", { mentions: [account] });
    await answered.promise;
    await second.runtime(agentId)?.idle();
    env.provider.assertComplete();
  });
});

describe("pausing and resuming", () => {
  it("aborts the model request on pause, notifies nobody while paused, and hands the model the accumulated notice on resume", async () => {
    const env = await environment();
    const manager = await env.open();
    const { agentId, account } = await env.hire(manager);
    env.workspaces.workspace(agentId).answerAll(() => text("ok"));
    let cancelled: Promise<void> | undefined;
    env.provider.step("first notice", (request) => {
      cancelled = request.hang();
    });
    env.post("One.", { mentions: [account] });
    await env.provider.received(1);

    await manager.pause(agentId);
    await cancelled;
    expect(manager.runtime(agentId), "no runtime while paused").toBeUndefined();

    env.post("Two.");
    env.post("Three.");
    await settle();
    expect(env.provider.requests, "messages while paused do not call the model").toHaveLength(1);
    expect(env.reports, "nothing tried to reach the closed runtime").toEqual([]);

    const resumed = Promise.withResolvers<void>();
    env.provider
      .step("resumed", async (request) => {
        expect(notices(request.userTexts())[0], "the interrupted work resumes").toMatch(
          /至少有 1 条未读/,
        );
        // Answer once the connector caught up, so the accumulated notice is surely queued behind this round.
        await resumed.promise;
        request.call([{ name: "bash", arguments: { command: "true" } }]);
      })
      .step("accumulated", (request) => {
        const seen = notices(request.userTexts());
        expect(seen, "one notice before the pause, one for the pause").toHaveLength(2);
        expect(seen[1], "the new notice counts everything unread").toMatch(/至少有 3 条未读/);
        request.text("caught up");
      });
    await manager.resume(agentId);
    resumed.resolve();
    await env.provider.received(3);
    await manager.runtime(agentId)?.idle();

    env.provider.assertComplete();
  });

  it("hands the model one notice counting every message that arrived while it was paused", async () => {
    const env = await environment();
    const manager = await env.open();
    const { agentId } = await env.hire(manager);
    await manager.pause(agentId);
    for (const body of ["One.", "Two.", "Three.", "Four.", "Five."]) env.post(body);

    env.provider.step("resumed", (request) => {
      const seen = notices(request.userTexts());
      expect(seen, "one notice").toHaveLength(1);
      expect(seen[0], "counting all five").toMatch(/至少有 5 条未读/);
      request.text("caught up");
    });
    await manager.resume(agentId);
    await env.provider.received(1);
    await manager.runtime(agentId)?.idle();

    env.provider.assertComplete();
  });

  it("stops a workspace call in flight on pause, and the model learns of it after resume", async () => {
    const env = await environment();
    const manager = await env.open();
    const { agentId, account } = await env.hire(manager);
    env.provider.step(
      "build",
      (request) => void request.call([{ name: "bash", arguments: { command: "make" } }]),
    );
    env.post("Build it, @richard.", { mentions: [account] });
    const call = await env.workspaces.workspace(agentId).nextCall();

    await manager.pause(agentId);

    expect(call.signal.aborted, "the workspace call was told to stop").toBe(true);
    env.provider.step("after resume", (request) => {
      expect(request.toolOutputs().join(), "the call did not finish").toMatch(/stopped|interrupt/i);
      request.text("I will check the build");
    });
    await manager.resume(agentId);
    await env.provider.received(2);
    await manager.runtime(agentId)?.idle();
    expect(env.workspaces.workspace(agentId).calls, "the command was not run again").toHaveLength(
      1,
    );
    env.provider.assertComplete();
  });

  it("ends concurrent resume, pause, resume as if run in order, never with two runtimes alive", async () => {
    const env = await environment();
    const manager = await env.open();
    const agentId = await manager.create({
      displayName: "Richard",
      handle: "richard",
      settings,
      nodeId,
    });
    await manager.pause(agentId);
    // A runtime is alive from the moment it asks for its workspace until its close has finished.
    let alive = 0;
    let mostAlive = 0;
    env.workspaces.onOpen = () => (mostAlive = Math.max(mostAlive, ++alive));
    const close = AgentRuntime.prototype.close;
    const closing = vi.spyOn(AgentRuntime.prototype, "close").mockImplementation(async function (
      this: AgentRuntime,
    ) {
      await close.call(this);
      alive -= 1;
    });
    onTestFinished(() => closing.mockRestore());
    const order: string[] = [];

    await Promise.all([
      manager.resume(agentId).then(() => order.push("resume")),
      manager.pause(agentId).then(() => order.push("pause")),
      manager.resume(agentId).then(() => order.push("resume again")),
    ]);

    expect(mostAlive, "never two runtimes alive at once").toBe(1);
    expect(order, "each call finished in the order it arrived").toEqual([
      "resume",
      "pause",
      "resume again",
    ]);
    expect(alive, "one alive at the end").toBe(1);
    expect(manager.list(), "open at the end").toEqual([{ agentId, open: true }]);
    await manager.close();
    expect(await readAgentState(join(env.directory, `${agentId}.sqlite`))).toMatchObject({
      paused: false,
    });
  });

  it("resuming an open Agent changes nothing, and it keeps working", async () => {
    const env = await environment();
    const manager = await env.open();
    const { agentId, account } = await env.hire(manager);

    await manager.resume(agentId);
    await manager.resume(agentId);

    const answered = Promise.withResolvers<void>();
    env.provider.step("notice", (request) => {
      expect(notices(request.userTexts()), "the Agent is notified").toHaveLength(1);
      request.text("seen");
      answered.resolve();
    });
    env.post("Still there, @richard?", { mentions: [account] });
    await answered.promise;
    await manager.runtime(agentId)?.idle();
    expect(env.reports, "nothing failed").toEqual([]);
    expect(manager.list()).toEqual([{ agentId, open: true }]);
    env.provider.assertComplete();
  });

  it("reports a runtime whose storage failed, lists it closed, and opens it again on resume", async () => {
    const env = await environment();
    const manager = await env.open();
    const { agentId, account } = await env.hire(manager);
    const file = join(env.directory, `${agentId}.sqlite`);
    // Another connection makes the store refuse new submissions, so the notice's commit fails.
    const outside = new DatabaseSync(file);
    onTestFinished(() => outside.close());
    outside.exec(
      "CREATE TRIGGER refuse BEFORE INSERT ON submissions BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    env.post("One.", { mentions: [account] });
    await vi.waitFor(() => expect(env.reports, "the failure is reported").not.toEqual([]));
    outside.exec("DROP TRIGGER refuse");

    await vi.waitFor(() =>
      expect(manager.list(), "a dead runtime is not open").toEqual([{ agentId, open: false }]),
    );
    expect(manager.runtime(agentId)).toBeUndefined();

    env.provider.step("reopened", (request) => {
      expect(notices(request.userTexts()), "the notice reaches the reopened runtime").toHaveLength(
        1,
      );
      request.text("seen");
    });
    await manager.resume(agentId);
    await env.provider.received(1);
    await manager.runtime(agentId)?.idle();
    expect(manager.list()).toEqual([{ agentId, open: true }]);
    env.provider.assertComplete();
  });
});

describe("a bad Agent ID", () => {
  it("rejects every lifecycle call instead of throwing", async () => {
    const env = await environment();
    const manager = await env.open();
    const calls = {
      create: () =>
        manager.create({ agentId: "../x", displayName: "X", handle: "x", settings, nodeId }),
      pause: () => manager.pause("../x"),
      resume: () => manager.resume("../x"),
      delete: () => manager.delete("../x"),
    };
    for (const [name, call] of Object.entries(calls)) {
      let returned: Promise<unknown> | undefined;
      expect(() => (returned = call()), `${name} does not throw`).not.toThrow();
      await expect(returned, `${name} rejects`).rejects.toThrow(/not an Agent ID/);
    }
  });
});

describe("deleting an Agent", () => {
  it("removes its file, deactivates its account, and keeps its past messages readable", async () => {
    const env = await environment();
    const manager = await env.open();
    const { agentId, account } = await env.hire(manager);
    env.chat.send(account, { conversation: env.general }, { requestId: "said", body: "Hello." });

    await manager.delete(agentId);

    expect(existsSync(join(env.directory, `${agentId}.sqlite`)), "the file is gone").toBe(false);
    expect(manager.list(), "the Agent no longer exists").toEqual([]);
    expect(manager.runtime(agentId)).toBeUndefined();
    expect(() => env.chat.listConversations(account), "the account cannot act").toThrow(
      /deactivated/,
    );
    expect(env.messages(), "its message is still readable").toEqual([
      { author: account, body: "Hello." },
    ]);

    const restarted = await env.open();
    expect(restarted.list(), "and does not come back on restart").toEqual([]);
  });
});
