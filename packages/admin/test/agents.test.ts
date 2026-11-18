import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  encodeMemoryReadOutcome,
  encodeTerminalOutcome,
  encodeTerminalWaitOutcome,
} from "@palace/node-protocol";
import { FakeNode } from "@palace/testkit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { AdminError } from "../src/index.ts";
import { environment, newIdentity, ok, settings } from "./support.ts";

describe("creating an Agent on a node", () => {
  it("prepares the workspace on the chosen node, and the Agent's commands run there", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const other = await env.pairNode(admin);
    const chosen = await env.pairNode(admin);
    chosen.answer = async () => ({ outputs: ["building\n"], result: ok("built") });

    const { agentId, account } = await env.hire(admin, chosen.nodeId);
    env.provider
      .step(
        "build",
        (request) => void request.call([{ name: "exec_command", arguments: { command: "make" } }]),
      )
      .step("done", (request) => {
        expect(request.toolOutputs().join(), "the chosen node answered").toContain("built");
        request.text("built it");
      });
    env.post("Build it, @richard.", [account]);
    await env.provider.received(2);

    expect(chosen.prepared, "the workspace is on the chosen node").toEqual([
      { agentId, access: "home" },
    ]);
    expect(other.prepared, "and on no other").toEqual([]);
    await vi.waitFor(() => expect(chosen.calls.map((call) => call.agentId)).toEqual([agentId]));
    expect(other.calls, "no command ran elsewhere").toEqual([]);
    expect(await admin.agents()).toEqual([
      expect.objectContaining({ agentId, nodeId: chosen.nodeId, state: "open" }),
    ]);
  });

  it("refuses a node that is not paired, and creates nothing", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);

    await expect(
      admin.createAgent({ nodeId: randomUUID(), displayName: "Lin", handle: "lin", settings }),
    ).rejects.toMatchObject({ reason: "unknown-node" });

    expect(await admin.agents(), "no Agent").toEqual([]);
    expect(env.chat.liveSnapshot(env.owner).accounts, "no chat account but the owner's").toEqual([
      expect.objectContaining({ handle: "owner" }),
    ]);
  });

  it("keeps running an Agent's commands on its node after the control plane restarts", async () => {
    const env = await environment();
    const first = await env.open();
    env.useScriptedProvider(first);
    await env.pairNode(first);
    const chosen = await env.pairNode(first);
    const { agentId, account } = await env.hire(first, chosen.nodeId);
    await first.close();

    const second = await env.open();
    env.provider
      .step(
        "ls",
        (request) => void request.call([{ name: "exec_command", arguments: { command: "ls" } }]),
      )
      .step("done", (request) => request.text("listed"));
    env.post("What is there, @richard?", [account]);
    await env.provider.received(2);

    expect(
      chosen.calls.map((call) => call.agentId),
      "the restarted Agent used its node",
    ).toEqual([agentId]);
    await second.close();
    env.provider.assertComplete();
  });
});

describe("listing Agents", () => {
  it("lists each Agent with its chat names, node, state, settings and usage", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const node = await env.pairNode(admin);
    const { agentId: richard, account } = await env.hire(admin, node.nodeId);
    const { agentId: lin } = await env.hire(admin, node.nodeId, {
      displayName: "Lin",
      handle: "lin",
    });
    env.provider.step("notice", (request) => request.text("seen", { inputTokens: 80 }));
    env.post("Morning, @richard.", [account]);
    await env.provider.received(1);
    await admin.pauseAgent(lin);

    const byId = new Map((await admin.agents()).map((agent) => [agent.agentId, agent]));

    expect(byId.get(richard)).toMatchObject({
      accountId: account,
      displayName: "Richard",
      handle: "richard",
      nodeId: node.nodeId,
      state: "open",
      settings,
    });
    expect(byId.get(lin)).toMatchObject({
      displayName: "Lin",
      handle: "lin",
      nodeId: node.nodeId,
      state: "paused",
      settings,
    });
    await vi.waitFor(async () => {
      const usage = (await admin.agents()).find((agent) => agent.agentId === richard);
      expect(usage, "the usage of the answered request").toMatchObject({
        usage: { models: { "openai/gpt-4.1": { input: 80 } } },
      });
    });
  });

  it("lists an Agent whose file is unreadable with the problem, and the others as they are", async () => {
    const env = await environment();
    const first = await env.open();
    env.useScriptedProvider(first);
    const node = await env.pairNode(first);
    const { agentId } = await env.hire(first, node.nodeId);
    await first.close();
    const broken = randomUUID();
    env.chat.ensureAccount({
      externalId: broken,
      displayName: "Lin",
      handle: "lin",
      kind: "agent",
    });
    writeFileSync(join(env.data, "agents", `${broken}.sqlite`), "this is not a database");

    const admin = await env.open();
    const byId = new Map((await admin.agents()).map((agent) => [agent.agentId, agent]));

    expect(byId.get(agentId)).toMatchObject({ state: "open", handle: "richard" });
    expect(byId.get(broken)).toMatchObject({ state: "unreadable", handle: "lin" });
    await admin.deleteAgent(broken);
    expect(
      (await admin.agents()).map((agent) => agent.agentId),
      "deleted",
    ).toEqual([agentId]);
  });
});

describe("pausing, resuming and deleting", () => {
  it("stops the Agent's command on its node when it is paused, and the model learns of it on resume", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const node = await env.pairNode(admin);
    node.answer = () => new Promise(() => undefined);
    const { agentId, account } = await env.hire(admin, node.nodeId);
    env.provider.step(
      "build",
      (request) => void request.call([{ name: "exec_command", arguments: { command: "make" } }]),
    );
    env.post("Build it, @richard.", [account]);
    await vi.waitFor(() => expect(node.calls, "the command is running").toHaveLength(1));

    await admin.pauseAgent(agentId);

    await vi.waitFor(() =>
      expect(node.stopped, "the node was told to stop it").toEqual([node.calls[0]?.requestId]),
    );
    expect(await admin.agents()).toEqual([expect.objectContaining({ state: "paused" })]);
    env.provider.step("after resume", (request) => {
      expect(request.toolOutputs().join(), "the call did not finish").toMatch(/stopped|interrupt/i);
      request.text("I will check the build");
    });
    await admin.resumeAgent(agentId);
    await env.provider.received(2);
    expect(node.calls, "the command was not run again").toHaveLength(1);
    expect(await admin.agents()).toEqual([expect.objectContaining({ state: "open" })]);
  });

  it("refuses lifecycle calls for an Agent that does not exist", async () => {
    const env = await environment();
    const admin = await env.open();
    const missing = randomUUID();
    for (const call of [
      () => admin.pauseAgent(missing),
      () => admin.resumeAgent(missing),
      () => admin.deleteAgent(missing),
      () => admin.configureAgent(missing, settings),
      () => admin.watchAgent(missing, () => undefined),
    ])
      await expect(call()).rejects.toMatchObject({ reason: "unknown-agent" });
    await expect(admin.pauseAgent("../x")).rejects.toBeInstanceOf(AdminError);
  });

  it("deletes an Agent: it is gone from the list, and its account is deactivated", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const node = await env.pairNode(admin);
    const { agentId, account } = await env.hire(admin, node.nodeId);

    await admin.deleteAgent(agentId);

    expect(await admin.agents()).toEqual([]);
    expect(env.chat.liveSnapshot(env.owner).accounts).toContainEqual(
      expect.objectContaining({ accountId: account, active: false }),
    );
  });

  it("loads memory/MEMORY.md from the home node into the system prompt before turns", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const node = await env.pairNode(admin);
    node.answerMemory = async () => ({
      outputs: [],
      result: encodeMemoryReadOutcome({
        status: "ok",
        content: "- keep deploy logs concise",
        truncated: false,
      }),
    });
    const { agentId, account } = await env.hire(admin, node.nodeId);
    env.provider.step("check memory", (request) => {
      const system = request.systemTexts().join("\n");
      expect(system).toContain('<memory_index path="memory/MEMORY.md">');
      expect(system).toContain("- keep deploy logs concise");
      request.text("checked");
    });

    env.post("Check memory, @richard.", [account]);
    await env.provider.received(1);
    expect(node.memoryReads).toContainEqual(
      expect.objectContaining({ agentId, tool: "memory_read", access: "home" }),
    );
    env.provider.assertComplete();
  });

  it("sends a kill request for an exec_command whose background transition raced pauseAgent and waits for termination before returning", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const node = await env.pairNode(admin);
    const execArrived = Promise.withResolvers<void>();
    const killArrived = Promise.withResolvers<void>();
    const releaseKill = Promise.withResolvers<void>();
    node.answer = () => {
      execArrived.resolve();
      return new Promise(() => undefined);
    };
    node.answerKill = async (call) => {
      killArrived.resolve();
      await releaseKill.promise;
      return {
        outputs: [],
        result: encodeTerminalOutcome({
          running: false,
          sessionId: String(call.arguments.sessionId ?? ""),
          output: "",
          droppedBytes: 0,
          wallTimeMs: 0,
          ending: { kind: "killed" },
          pipesHeld: false,
          backgroundRunning: false,
        }),
      };
    };

    const { agentId, account } = await env.hire(admin, node.nodeId);
    env.provider.step("build", (request) => {
      request.call([{ name: "exec_command", arguments: { command: "make" } }]);
    });
    env.post("Build it, @richard.", [account]);
    await execArrived.promise;

    let pausedFinished = false;
    const pausing = admin.pauseAgent(agentId).then(() => {
      pausedFinished = true;
    });
    await killArrived.promise;
    await Promise.resolve();
    expect(pausedFinished, "pauseAgent waits for cleanup kill acknowledgement").toBe(false);
    expect(node.kills).toEqual([
      expect.objectContaining({
        agentId,
        tool: "terminal_write",
        arguments: { sessionId: expect.any(String), yieldTimeMs: 0, kill: true },
      }),
    ]);

    releaseKill.resolve();
    await pausing;
    expect(pausedFinished).toBe(true);
    expect(await admin.agents()).toEqual([expect.objectContaining({ state: "paused" })]);
  });

  it(
    "retains routing for a long-running terminal session across more than 1,024 completed short sessions",
    { timeout: 60_000 },
    async () => {
      const env = await environment();
      const admin = await env.open();
      env.useScriptedProvider(admin);
      const node = await env.pairNode(admin);
      let longSessionId = "";
      node.answer = async (call) => {
        if (call.tool === "terminal_exec") {
          const sessionId = String(call.arguments.sessionId);
          if (call.arguments.command === "long-job") longSessionId = sessionId;
          return {
            outputs: [],
            result: encodeTerminalOutcome({
              running: true,
              sessionId,
              output: "",
              droppedBytes: 0,
              wallTimeMs: 10,
            }),
          };
        }
        const sessionId = String(call.arguments.sessionId);
        if (sessionId === longSessionId) {
          return {
            outputs: [],
            result: encodeTerminalOutcome({
              running: true,
              sessionId,
              output: "pong\n",
              droppedBytes: 0,
              wallTimeMs: 20,
            }),
          };
        }
        return {
          outputs: [],
          result: encodeTerminalOutcome({
            running: false,
            sessionId,
            output: "short-done\n",
            droppedBytes: 0,
            wallTimeMs: 15,
            ending: { kind: "exited", code: 0 },
            pipesHeld: false,
            backgroundRunning: false,
          }),
        };
      };

      const { agentId, account } = await env.hire(admin, node.nodeId);
      env.provider.step("start long session", (request) => {
        request.call([
          { name: "exec_command", arguments: { command: "long-job", yield_time_ms: 10 } },
        ]);
      });
      const batches = 5;
      const perBatch = 205;
      for (let b = 0; b < batches; b++) {
        env.provider.step(`short exec batch ${b}`, (request) => {
          request.call(
            Array.from({ length: perBatch }, () => ({
              name: "exec_command",
              arguments: { command: "short", yield_time_ms: 10 },
            })),
          );
        });
        env.provider.step(`short finish batch ${b}`, (request) => {
          const outputs = request.toolOutputs().slice(-perBatch);
          const ids = outputs.map((text) => /session_id:\s*([^\]]+)/.exec(text)?.[1] ?? "");
          expect(ids.every((id) => id.length > 0)).toBe(true);
          request.call(
            ids.map((id) => ({
              name: "write_stdin",
              arguments: { session_id: id, yield_time_ms: 10 },
            })),
          );
        });
      }
      env.provider
        .step("check long session", (request) => {
          request.call([
            {
              name: "write_stdin",
              arguments: { session_id: longSessionId, chars: "ping\n", yield_time_ms: 10 },
            },
          ]);
        })
        .step("done", (request) => {
          expect(request.toolOutputs().at(-1)).toContain("pong");
          request.text("long session intact");
        });

      env.post("Run many sessions, @richard.", [account]);
      await env.provider.received(batches * 2 + 3);
      env.provider.assertComplete();

      await admin.pauseAgent(agentId);
      expect(node.kills.some((call) => call.arguments.sessionId === longSessionId)).toBe(true);
    },
  );

  it("keeps a legacy home node online and serves supported tools when it connects without advertising newer tools", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const identity = newIdentity();
    const arrivedTools: string[] = [];
    const legacy = new FakeNode({
      gatewayUrl: env.gatewayUrl,
      ...identity,
      pairingToken: admin.createPairingToken().pairingToken,
      tools: null,
      onRunTool: async (call) => {
        if (!["bash", "read", "write", "edit"].includes(call.tool)) {
          legacy.terminate();
          throw new Error(`unexpected tool for legacy node: ${call.tool}`);
        }
        arrivedTools.push(call.tool);
        return { outputs: [], result: ok("legacy file content") };
      },
    });
    onTestFinished(() => legacy.terminate());
    await legacy.connect();

    const { agentId, account } = await env.hire(admin, identity.nodeId);
    let readCallId = "";
    env.provider
      .step("read file", (request) => {
        expect(request.systemTexts().join("\n")).toContain("memory/MEMORY.md could not be read");
        readCallId = request.call([{ name: "read", arguments: { path: "notes.txt" } }])[0] ?? "";
      })
      .step("reply", (request) => {
        expect(request.toolOutput(readCallId)).toContain("legacy file content");
        request.text("done on legacy node");
      });

    env.post("Check notes, @richard.", [account]);
    await env.provider.received(2);
    expect(arrivedTools).toEqual(["read"]);
    expect(env.gateway.status(identity.nodeId).online).toBe(true);
    await admin.pauseAgent(agentId);
    env.provider.assertComplete();
  });

  it.each(["exec", "write", "wait"] as const)(
    "stops the process on pause when %s reported a failed stop",
    async (failureAt) => {
      const env = await environment();
      const admin = await env.open();
      env.useScriptedProvider(admin);
      const node = await env.pairNode(admin);
      const exit = Promise.withResolvers<void>();
      let sessionId = "";
      node.answer = async (call) => {
        sessionId = String(call.arguments.sessionId);
        const outcome = { sessionId, output: "", droppedBytes: 0, wallTimeMs: 10 };
        const failure = {
          ...outcome,
          running: false,
          ending: { kind: "stop-failed", reason: "still alive" },
          pipesHeld: false,
          backgroundRunning: false,
        } as const;
        if (call.tool === "terminal_wait") {
          await exit.promise;
          return {
            outputs: [],
            result: encodeTerminalWaitOutcome({ consumed: false, outcome: failure }),
          };
        }
        return {
          outputs: [],
          result: encodeTerminalOutcome(
            failureAt !== "exec" && call.tool === "terminal_exec"
              ? { ...outcome, running: true }
              : failure,
          ),
        };
      };
      const { agentId, account } = await env.hire(admin, node.nodeId);
      env.provider.step("start", (request) => {
        request.call([
          {
            name: "exec_command",
            arguments: { command: "job", timeout_ms: 10, notify_on_exit: failureAt === "wait" },
          },
        ]);
      });
      if (failureAt === "write") {
        env.provider.step("poll", (request) => {
          request.call([{ name: "write_stdin", arguments: { session_id: sessionId } }]);
        });
      } else if (failureAt === "wait") {
        env.provider.step("wait for the job", (request) => request.text("Running."));
      }
      env.provider.step("read stop failure", (request) => {
        if (failureAt !== "wait") expect(request.toolOutputs().at(-1)).toContain(sessionId);
        expect([...request.toolOutputs(), ...request.userTexts()].join("\n")).toContain(
          "still alive",
        );
        request.text("The process may still be running.");
      });
      env.post("Start the job, @richard.", [account]);
      await env.provider.received(2);
      exit.resolve();
      if (failureAt !== "exec") await env.provider.received(3);
      await admin.pauseAgent(agentId);
      expect(node.kills.map((call) => call.arguments.sessionId)).toEqual([sessionId]);
      env.provider.assertComplete();
    },
  );

  it("retries an unconfirmed pause after restart until the node confirms the stop", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const node = await env.pairNode(admin);
    node.answer = async (call) => ({
      outputs: [],
      result: encodeTerminalOutcome({
        running: true,
        sessionId: String(call.arguments.sessionId),
        output: "",
        droppedBytes: 0,
        wallTimeMs: 10,
      }),
    });

    const killArrived = Promise.withResolvers<void>();
    let killBehavior: "hang" | "stop-failed" | "killed" = "hang";
    node.answerKill = async (call) => {
      if (killBehavior === "hang") {
        killArrived.resolve();
        return new Promise(() => undefined);
      }
      if (killBehavior === "stop-failed") {
        return {
          outputs: [],
          result: encodeTerminalOutcome({
            running: false,
            sessionId: String(call.arguments.sessionId ?? ""),
            output: "",
            droppedBytes: 0,
            wallTimeMs: 5,
            ending: { kind: "stop-failed", reason: "process group still alive" },
            pipesHeld: false,
            backgroundRunning: false,
          }),
        };
      }
      return {
        outputs: [],
        result: encodeTerminalOutcome({
          running: false,
          sessionId: String(call.arguments.sessionId ?? ""),
          output: "",
          droppedBytes: 0,
          wallTimeMs: 5,
          ending: { kind: "killed" },
          pipesHeld: false,
          backgroundRunning: false,
        }),
      };
    };

    const { agentId, account } = await env.hire(admin, node.nodeId);
    env.provider
      .step("start yielded job", (request) => {
        request.call([
          { name: "exec_command", arguments: { command: "long-job", yield_time_ms: 10 } },
        ]);
      })
      .step("answer after yield", (request) => request.text("Running in background."));
    env.post("Start background work, @richard.", [account]);
    await env.provider.received(2);
    await vi.waitFor(() => expect(node.sessionWatches).toHaveLength(1));

    const firstPause = admin.pauseAgent(agentId);
    await killArrived.promise;
    env.clock.advance(5_000);
    await expect(firstPause).rejects.toMatchObject({ reason: "stop-unconfirmed" });
    expect(await admin.agents()).toEqual([expect.objectContaining({ agentId, state: "paused" })]);

    await admin.close();
    const reopened = await env.open();
    expect(await reopened.agents()).toMatchObject([
      { agentId, state: "paused", pendingTerminalStops: true },
    ]);
    killBehavior = "stop-failed";
    await expect(reopened.pauseAgent(agentId)).rejects.toMatchObject({
      reason: "stop-unconfirmed",
    });

    killBehavior = "killed";
    await reopened.pauseAgent(agentId);
    expect((await reopened.agents())[0]).not.toHaveProperty("pendingTerminalStops");
    await reopened.pauseAgent(agentId);
    expect(node.kills).toHaveLength(3);
    env.provider.assertComplete();
  });

  it(
    "stops tracking 1,100 naturally exiting yielded sessions without sending pause kills",
    { timeout: 60_000 },
    async () => {
      const env = await environment();
      const admin = await env.open();
      env.useScriptedProvider(admin);
      const node = await env.pairNode(admin);
      let resolvedWatches = 0;
      node.answer = async (call) => ({
        outputs: [],
        result: encodeTerminalOutcome({
          running: true,
          sessionId: String(call.arguments.sessionId),
          output: "",
          droppedBytes: 0,
          wallTimeMs: 10,
        }),
      });
      node.answerSessionWatch = async () => {
        resolvedWatches++;
        return {
          outputs: [],
          result: encodeTerminalWaitOutcome({ consumed: true }),
        };
      };

      const { agentId, account } = await env.hire(admin, node.nodeId);
      const batches = 5;
      const perBatch = 220;
      for (let b = 0; b < batches; b++) {
        env.provider.step(`yield batch ${b}`, (request) => {
          request.call(
            Array.from({ length: perBatch }, () => ({
              name: "exec_command",
              arguments: { command: "short-yielded", yield_time_ms: 10 },
            })),
          );
        });
      }
      env.provider.step("done", (request) => request.text("All 1,100 started."));
      env.post("Start 1,100 yielded commands, @richard.", [account]);
      await env.provider.received(batches + 1);
      await vi.waitFor(() => expect(resolvedWatches).toBe(batches * perBatch));
      // Allow FakeNode to send the final watch result frames, then fence with a ping over the same WebSocket.
      await Promise.resolve();
      node.node.ping();
      await vi.waitFor(() => expect(node.node.pongs).toBeGreaterThanOrEqual(1));
      await Promise.resolve();

      await admin.pauseAgent(agentId);
      expect(node.kills).toEqual([]);
      env.provider.assertComplete();
    },
  );
});
