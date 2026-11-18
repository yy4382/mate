import { LiveDoc, ToolResultEntry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import {
  encodeTerminalOutcome,
  encodeTerminalWaitOutcome,
  type ToolResult,
} from "@palace/node-protocol";
import { describe, expect, it, vi } from "vitest";
import { filesExtension, type FilesPort } from "../src/files.ts";
import { listSubagents, subagentConversationId, subagentExtension } from "../src/subagent.ts";
import { terminalExtension, type TerminalPort } from "../src/terminal.ts";
import { testAgent, within } from "./support.ts";

describe("subagent extension", () => {
  it("runs foreground and background subagents, supports resume, and exposes subagent helpers", async () => {
    const dummyExt = defineExtension({ name: "helper-ext" });
    const primaryOnlyTool = defineTool({
      name: "primary_only",
      description: "Primary-only tool.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    const primaryExt = defineExtension({ name: "primary-only", tools: [primaryOnlyTool] });
    const subagent = subagentExtension({ extensions: [dummyExt] });

    const agent = await testAgent();
    const seenWorkerTools: string[][] = [];
    let firstAgentId = "";
    let fgResult = "";
    const bgDelivered = Promise.withResolvers<string>();

    agent.provider
      .step("root foreground", (request) => {
        request.call([
          { name: "subagent", arguments: { prompt: "count one", description: "fg task" } },
        ]);
      })
      .step("root reads fg and starts bg", (request) => {
        fgResult = request.toolOutputs().at(-1) ?? "";
        firstAgentId = /Subagent (sub-\d+):/.exec(fgResult)?.[1] ?? "";
        expect(firstAgentId).toMatch(/^sub-\d+$/);
        request.call([
          {
            name: "subagent",
            arguments: { prompt: "slow two", run_in_background: true, resume: firstAgentId },
          },
        ]);
      })
      .step("root answers while bg runs", (request) => {
        const out = JSON.parse(request.toolOutputs().at(-1) ?? "null");
        expect(out).toEqual({ status: "running", agent_id: firstAgentId });
        request.text("Delegated to background.");
      })
      .step("root receives subagent_result", (request) => {
        const text = request.userTexts().at(-1) ?? "";
        bgDelivered.resolve(text);
        request.text("Got final result.");
      });

    const holdBg = Promise.withResolvers<void>();
    agent.provider
      .lane("worker", (request) => request.userTexts()[0] === "count one")
      .step("worker fg", (request) => {
        seenWorkerTools.push(request.toolNames());
        request.text("Count is 1.");
      })
      .step("worker bg resumed", async (request) => {
        expect(request.userTexts()).toEqual(["count one", "slow two"]);
        await holdBg.promise;
        request.text("Background done (resumed).");
      });

    const { runtime } = await agent.open({ extensions: [primaryExt, dummyExt, subagent] });
    await (await runtime.submit("start", { requestId: "m1" })).settled();
    expect(fgResult).toContain("Count is 1.");
    expect(seenWorkerTools[0]).not.toContain("primary_only");
    expect(seenWorkerTools[0]).not.toContain("subagent");
    expect(seenWorkerTools[0]).not.toContain("subagent_stop");
    expect(await listSubagents(runtime)).toEqual([firstAgentId]);
    expect(await subagentConversationId(runtime, firstAgentId)).toBeTypeOf("number");

    // Parent can settle while background subagent is waiting on holdBg.
    await runtime.idle();
    holdBg.resolve();

    const delivery = await within(2000, "background subagent_result", bgDelivered.promise);
    expect(delivery).toContain(`<subagent_result agent_id="${firstAgentId}" status="completed">`);
    expect(delivery).toContain("Background done (resumed).");
    await runtime.idle();
    agent.provider.assertComplete();
  });

  it("stops a running background subagent cleanly with subagent_stop and leaves it resumable", async () => {
    const subagent = subagentExtension({ extensions: [] });
    const agent = await testAgent();
    const stopGate = Promise.withResolvers<void>();
    let cancelledSeen = false;
    let agentId = "";

    agent.provider
      .step("start bg", (request) => {
        request.call([
          { name: "subagent", arguments: { prompt: "hang forever", run_in_background: true } },
        ]);
      })
      .step("ack bg", (request) => {
        agentId = JSON.parse(request.toolOutputs().at(-1) ?? "null").agent_id;
        request.text("started");
      })
      .step("stop it", (request) => {
        request.call([{ name: "subagent_stop", arguments: { agent_id: agentId } }]);
      })
      .step("after stop", (request) => {
        expect(request.toolOutputs().at(-1)).toContain(`Stopped subagent ${agentId}`);
        request.text("stopped");
      })
      .step("resume after stop", (request) => {
        request.call([{ name: "subagent", arguments: { prompt: "try again", resume: agentId } }]);
      })
      .step("done", (request) => {
        expect(request.toolOutputs().at(-1)).toContain("recovered ok");
        request.text("all done");
      });

    agent.provider
      .lane("worker", (request) => request.userTexts()[0] === "hang forever")
      .step("hanging", (request) => {
        stopGate.resolve();
        return request.hang().then(() => {
          cancelledSeen = true;
        });
      })
      .step("resumed", (request) => request.text("recovered ok"));

    const { runtime } = await agent.open({ extensions: [subagent] });
    await (await runtime.submit("start", { requestId: "m1" })).settled();
    await within(2000, "worker request started", stopGate.promise);

    await (await runtime.submit("stop", { requestId: "m2" })).settled();
    expect(cancelledSeen).toBe(true);

    await (await runtime.submit("resume", { requestId: "m3" })).settled();
    await runtime.idle();
    agent.provider.assertComplete();
  });

  it("waits for a background subagent's notify_on_exit command to complete before delivering subagent_result", async () => {
    const waitCallReady = Promise.withResolvers<() => void>();
    const termPort: TerminalPort = {
      exec: async (call) =>
        encodeTerminalOutcome({
          running: true,
          sessionId: call.sessionId,
          output: "",
          droppedBytes: 0,
          wallTimeMs: 10,
        }),
      write: async (call) =>
        encodeTerminalOutcome({
          running: false,
          sessionId: call.sessionId,
          output: "",
          droppedBytes: 0,
          wallTimeMs: 10,
          ending: { kind: "exited", code: 0 },
          pipesHeld: false,
          backgroundRunning: false,
        }),
      wait: (call) =>
        new Promise((resolve) => {
          waitCallReady.resolve(() =>
            resolve(
              encodeTerminalWaitOutcome({
                consumed: false,
                outcome: {
                  running: false,
                  sessionId: call.sessionId,
                  output: "42 tests passed\n",
                  droppedBytes: 0,
                  wallTimeMs: 200,
                  ending: { kind: "exited", code: 0 },
                  pipesHeld: false,
                  backgroundRunning: false,
                },
              }),
            ),
          );
        }),
    };
    const terminal = terminalExtension(termPort);
    const subagent = subagentExtension({ extensions: [terminal] });
    const agent = await testAgent();
    const resultDelivered = Promise.withResolvers<string>();

    agent.provider
      .step("delegate", (request) => {
        request.call([
          { name: "subagent", arguments: { prompt: "run slow suite", run_in_background: true } },
        ]);
      })
      .step("ack", (request) => request.text("Subagent started."))
      .step("receives subagent_result", (request) => {
        const text = request.userTexts().at(-1) ?? "";
        resultDelivered.resolve(text);
        request.text("Reported final answer.");
      });

    const workerLane = agent.provider
      .lane("worker", (request) => request.userTexts()[0] === "run slow suite")
      .step("worker starts cmd", (request) => {
        request.call([
          {
            name: "exec_command",
            arguments: { command: "pnpm test", yield_time_ms: 10, notify_on_exit: true },
          },
        ]);
      })
      .step("worker ends turn 1", (request) => {
        request.text("Started test run, waiting for notification.");
      })
      .step("worker receives command notification", (request) => {
        expect(request.userTexts().at(-1)).toContain("42 tests passed");
        request.text("Suite complete: 42 tests passed.");
      });

    const { runtime } = await agent.open({ extensions: [terminal, subagent] });
    await (await runtime.submit("go", { requestId: "m1" })).settled();
    const finishCommand = await within(2000, "command wait started", waitCallReady.promise);
    await within(2000, "worker turn 1", workerLane.received(2));
    const childId = await subagentConversationId(runtime, "sub-1");
    expect(childId).toBeDefined();
    await vi.waitFor(async () => {
      expect((await runtime.snapshot(LiveDoc, childId!))?.run).toBeUndefined();
    });
    // Worker ended turn 1 already; root must NOT have received subagent_result yet!
    await runtime.idle();
    expect(agent.provider.requests.some((r) => r.step === "receives subagent_result")).toBe(false);

    finishCommand();
    const delivered = await within(2000, "final subagent_result", resultDelivered.promise);
    expect(delivered).toContain("Suite complete: 42 tests passed.");
    expect(delivered).not.toContain("Started test run");
    await runtime.idle();
    agent.provider.assertComplete();
  });

  it("propagates runtime.configure model updates to subagents without widening allowed extensions and rejects self-nesting", async () => {
    expect(() =>
      subagentExtension({ extensions: [defineExtension({ name: "subagent" })] }),
    ).toThrow(/subagent/);

    const files = filesExtension({
      run: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
      nodes: async () => [],
    } satisfies FilesPort);
    const hiddenPrimary = defineExtension({
      name: "secret-primary",
      tools: [
        defineTool({
          name: "secret_tool",
          description: "Not for subagents.",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => ({ content: [{ type: "text", text: "secret" }] }),
        }),
      ],
    });
    const subagent = subagentExtension({ extensions: [files] });
    const agent = await testAgent();
    let secondChildModel = "";
    let secondChildTools: string[] = [];

    agent.provider
      .step("spawn", (request) => {
        request.call([{ name: "subagent", arguments: { prompt: "first task" } }]);
      })
      .step("re-ack", (request) => request.text("done1"))
      .step("spawn2", (request) => {
        const id = /Subagent (sub-\d+):/.exec(request.toolOutputs()[0] ?? "")?.[1] ?? "";
        request.call([{ name: "subagent", arguments: { prompt: "second task", resume: id } }]);
      })
      .step("done2", (request) => request.text("done2"));

    agent.provider
      .lane("worker", (request) => request.userTexts()[0] === "first task")
      .step("child1", (request) => request.text("child1 ok"))
      .step("child2", (request) => {
        secondChildModel = request.body.model;
        secondChildTools = request.toolNames();
        request.text("child2 ok");
      });

    const { runtime } = await agent.open({ extensions: [hiddenPrimary, files, subagent] });
    await (await runtime.submit("turn 1", { requestId: "m1" })).settled();
    await runtime.configure({ model: { provider: "openai", modelId: "gpt-4o" } });
    await (await runtime.submit("turn 2", { requestId: "m2" })).settled();

    expect(secondChildModel).toBe("gpt-4o");
    expect(secondChildTools).toContain("read");
    expect(secondChildTools).not.toContain("secret_tool");
    expect(secondChildTools).not.toContain("subagent");
  });

  it("propagates follow-up turn failures after notify_on_exit to both foreground and background subagents", async () => {
    const waiters = new Map<string, () => void>();
    const termPort: TerminalPort = {
      exec: async (call) =>
        encodeTerminalOutcome({
          running: true,
          sessionId: call.sessionId,
          output: "",
          droppedBytes: 0,
          wallTimeMs: 10,
        }),
      write: async (call) =>
        encodeTerminalOutcome({
          running: false,
          sessionId: call.sessionId,
          output: "",
          droppedBytes: 0,
          wallTimeMs: 10,
          ending: { kind: "exited", code: 0 },
          pipesHeld: false,
          backgroundRunning: false,
        }),
      wait: (call) =>
        new Promise((resolve) => {
          waiters.set(call.sessionId, () =>
            resolve(
              encodeTerminalWaitOutcome({
                consumed: false,
                outcome: {
                  running: false,
                  sessionId: call.sessionId,
                  output: "done\n",
                  droppedBytes: 0,
                  wallTimeMs: 50,
                  ending: { kind: "exited", code: 0 },
                  pipesHeld: false,
                  backgroundRunning: false,
                },
              }),
            ),
          );
        }),
    };
    const terminal = terminalExtension(termPort);
    const subagent = subagentExtension({ extensions: [terminal] });
    const agent = await testAgent();
    const bgDelivered = Promise.withResolvers<string>();
    const sessions: string[] = [];

    agent.provider
      .step("root fg", (request) => {
        request.call([{ name: "subagent", arguments: { prompt: "fg notify job" } }]);
      })
      .step("root sees fg failure and starts bg", (request) => {
        const fgOut = request.toolOutputs().at(-1) ?? "";
        expect(fgOut).toContain("bad follow-up fg");
        expect(fgOut).not.toContain("Still waiting fg.");
        request.call([
          { name: "subagent", arguments: { prompt: "bg notify job", run_in_background: true } },
        ]);
      })
      .step("root acks bg", (request) => request.text("Running bg."))
      .step("root sees bg failure", (request) => {
        const msg = request.userTexts().at(-1) ?? "";
        bgDelivered.resolve(msg);
        request.text("Handled bg failure.");
      });

    agent.provider
      .lane("fg worker", (request) => request.userTexts()[0] === "fg notify job")
      .step("fg starts cmd", (request) => {
        request.call([
          { name: "exec_command", arguments: { command: "job1", notify_on_exit: true } },
        ]);
      })
      .step("fg waits", (request) => {
        const id = /session_id:\s*(\S+?)\]/.exec(request.toolOutputs().at(-1) ?? "")?.[1] ?? "";
        sessions.push(id);
        setTimeout(() => waiters.get(id)?.(), 0);
        request.text("Still waiting fg.");
      })
      .step("fg follow-up HTTP 400", (request) => {
        request.status(400, "bad follow-up fg");
      });

    agent.provider
      .lane("bg worker", (request) => request.userTexts()[0] === "bg notify job")
      .step("bg starts cmd", (request) => {
        request.call([
          { name: "exec_command", arguments: { command: "job2", notify_on_exit: true } },
        ]);
      })
      .step("bg waits", (request) => {
        const id = /session_id:\s*(\S+?)\]/.exec(request.toolOutputs().at(-1) ?? "")?.[1] ?? "";
        sessions.push(id);
        setTimeout(() => waiters.get(id)?.(), 0);
        request.text("Still waiting bg.");
      })
      .step("bg follow-up HTTP 400", (request) => {
        request.status(400, "bad follow-up bg");
      });

    const { runtime } = await agent.open({ extensions: [terminal, subagent] });
    const events: ToolResult[] = [];
    const watch = await runtime.watchEvents((batch) => {
      for (const ev of batch) {
        if (
          ev.type === "tool_execution_end" &&
          ev.toolName === "subagent" &&
          ToolResultEntry.is(ev.entry)
        ) {
          const msg = ev.entry.model?.[0];
          if (msg?.role === "toolResult") {
            events.push({ content: [{ type: "text", text: "" }], isError: msg.isError });
          }
        }
      }
    });

    await (await runtime.submit("go", { requestId: "m1" })).settled();
    const bgMsg = await within(2000, "background failed delivery", bgDelivered.promise);
    expect(bgMsg).toContain('status="failed"');
    expect(bgMsg).toContain("bad follow-up bg");
    expect(bgMsg).not.toContain("Still waiting bg.");
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[0]?.isError).toBe(true);
    await watch.stop();
    await runtime.idle();
    agent.provider.assertComplete();
  });

  it("allows parent and subagent conversations to independently arm notify_on_exit on the same terminal session", async () => {
    const waiters: Array<{ conversationId: number; resolve: () => void }> = [];
    let sharedSessionId = "";
    const termPort: TerminalPort = {
      exec: async (call) => {
        sharedSessionId = call.sessionId;
        return encodeTerminalOutcome({
          running: true,
          sessionId: call.sessionId,
          output: "",
          droppedBytes: 0,
          wallTimeMs: 10,
        });
      },
      write: async (call) =>
        encodeTerminalOutcome({
          running: true,
          sessionId: call.sessionId,
          output: "",
          droppedBytes: 0,
          wallTimeMs: 20,
        }),
      wait: (call) =>
        new Promise((resolve) => {
          waiters.push({
            conversationId: call.conversationId,
            resolve: () =>
              resolve(
                encodeTerminalWaitOutcome({
                  consumed: false,
                  outcome: {
                    running: false,
                    sessionId: call.sessionId,
                    output: "shared finished\n",
                    droppedBytes: 0,
                    wallTimeMs: 100,
                    ending: { kind: "exited", code: 0 },
                    pipesHeld: false,
                    backgroundRunning: false,
                  },
                }),
              ),
          });
        }),
    };
    const terminal = terminalExtension(termPort);
    const subagent = subagentExtension({ extensions: [terminal] });
    const agent = await testAgent();
    const rootNotified = Promise.withResolvers<string>();
    const childResult = Promise.withResolvers<string>();

    agent.provider
      .step("root starts and watches", (request) => {
        request.call([
          {
            name: "exec_command",
            arguments: { command: "shared", yield_time_ms: 10, notify_on_exit: true },
          },
        ]);
      })
      .step("root delegates watch to bg subagent", (request) => {
        request.call([
          {
            name: "subagent",
            arguments: {
              prompt: `watch session ${sharedSessionId}`,
              run_in_background: true,
            },
          },
        ]);
      })
      .step("root answers turn 1", (request) => request.text("Both watching."))
      .step("root handles command_notification", (request) => {
        rootNotified.resolve(request.userTexts().at(-1) ?? "");
        request.text("Saw command exit.");
      })
      .step("root handles subagent_result", (request) => {
        childResult.resolve(request.userTexts().at(-1) ?? "");
        request.text("All settled.");
      });

    agent.provider
      .lane("watcher", (request) => (request.userTexts()[0] ?? "").startsWith("watch session "))
      .step("child arms watch", (request) => {
        request.call([
          {
            name: "write_stdin",
            arguments: { session_id: sharedSessionId, yield_time_ms: 10, notify_on_exit: true },
          },
        ]);
      })
      .step("child ends turn 1", (request) => request.text("Child watching."))
      .step("child woken", (request) => {
        expect(request.userTexts().at(-1)).toContain("shared finished");
        request.text("Child saw shared exit.");
      });

    const { runtime } = await agent.open({ extensions: [terminal, subagent] });
    await (await runtime.submit("go", { requestId: "m1" })).settled();
    await vi.waitFor(() => expect(waiters).toHaveLength(2));
    expect(new Set(waiters.map((w) => w.conversationId)).size).toBe(2);

    const rootWaiter = waiters.find((w) => w.conversationId === runtime.rootConversationId);
    const childWaiter = waiters.find((w) => w.conversationId !== runtime.rootConversationId);
    expect(rootWaiter).toBeDefined();
    expect(childWaiter).toBeDefined();

    rootWaiter!.resolve();
    const settledRoot = await within(2000, "root notification", rootNotified.promise);
    childWaiter!.resolve();
    const settledChild = await within(2000, "subagent result", childResult.promise);
    expect(settledRoot).toContain("shared finished");
    expect(settledChild).toContain("Child saw shared exit.");
    await runtime.idle();
    agent.provider.assertComplete();
  });

  it("propagates a follow-up failure immediately without waiting on sibling hung background commands", async () => {
    const waiters = new Map<
      string,
      { readonly signal: AbortSignal; readonly resolve: () => void }
    >();
    const termPort: TerminalPort = {
      exec: async (call) =>
        encodeTerminalOutcome({
          running: true,
          sessionId: call.sessionId,
          output: "",
          droppedBytes: 0,
          wallTimeMs: 10,
        }),
      write: async (call) =>
        encodeTerminalOutcome({
          running: true,
          sessionId: call.sessionId,
          output: "",
          droppedBytes: 0,
          wallTimeMs: 10,
        }),
      wait: (call, signal) =>
        new Promise((resolve) => {
          waiters.set(call.sessionId, {
            signal,
            resolve: () =>
              resolve(
                encodeTerminalWaitOutcome({
                  consumed: false,
                  outcome: {
                    running: false,
                    sessionId: call.sessionId,
                    output: "fast exit\n",
                    droppedBytes: 0,
                    wallTimeMs: 25,
                    ending: { kind: "exited", code: 0 },
                    pipesHeld: false,
                    backgroundRunning: false,
                  },
                }),
              ),
          });
        }),
    };
    const terminal = terminalExtension(termPort);
    const subagent = subagentExtension({ extensions: [terminal] });
    const agent = await testAgent();
    const bgDelivered = Promise.withResolvers<string>();
    const hungSignals: AbortSignal[] = [];

    agent.provider
      .step("root fg", (request) => {
        request.call([{ name: "subagent", arguments: { prompt: "fg two cmds" } }]);
      })
      .step("root sees fg failure and starts bg", (request) => {
        expect(request.toolOutputs().at(-1)).toContain("fg sibling 400");
        request.call([
          { name: "subagent", arguments: { prompt: "bg two cmds", run_in_background: true } },
        ]);
      })
      .step("root acks bg", (request) => request.text("Running bg."))
      .step("root sees bg failure", (request) => {
        bgDelivered.resolve(request.userTexts().at(-1) ?? "");
        request.text("Handled bg sibling failure.");
      });

    agent.provider
      .lane("fg sibling", (request) => request.userTexts()[0] === "fg two cmds")
      .step("fg starts two cmds", (request) => {
        request.call([
          { name: "exec_command", arguments: { command: "hung-cmd", notify_on_exit: true } },
          { name: "exec_command", arguments: { command: "fast-cmd", notify_on_exit: true } },
        ]);
      })
      .step("fg ends turn 1", (request) => {
        const outputs = request.toolOutputs().slice(-2);
        const hungId = /session_id:\s*(\S+?)\]/.exec(outputs[0] ?? "")?.[1] ?? "";
        const fastId = /session_id:\s*(\S+?)\]/.exec(outputs[1] ?? "")?.[1] ?? "";
        const hungWait = waiters.get(hungId);
        expect(hungWait).toBeDefined();
        hungSignals.push(hungWait!.signal);
        setTimeout(() => waiters.get(fastId)?.resolve(), 0);
        request.text("Waiting on both foreground commands.");
      })
      .step("fg fast follow-up 400", (request) => {
        request.status(400, "fg sibling 400");
      });

    agent.provider
      .lane("bg sibling", (request) => request.userTexts()[0] === "bg two cmds")
      .step("bg starts two cmds", (request) => {
        request.call([
          { name: "exec_command", arguments: { command: "hung-bg", notify_on_exit: true } },
          { name: "exec_command", arguments: { command: "fast-bg", notify_on_exit: true } },
        ]);
      })
      .step("bg ends turn 1", (request) => {
        const outputs = request.toolOutputs().slice(-2);
        const hungId = /session_id:\s*(\S+?)\]/.exec(outputs[0] ?? "")?.[1] ?? "";
        const fastId = /session_id:\s*(\S+?)\]/.exec(outputs[1] ?? "")?.[1] ?? "";
        const hungWait = waiters.get(hungId);
        expect(hungWait).toBeDefined();
        hungSignals.push(hungWait!.signal);
        setTimeout(() => waiters.get(fastId)?.resolve(), 0);
        request.text("Waiting on both background commands.");
      })
      .step("bg fast follow-up 400", (request) => {
        request.status(400, "bg sibling 400");
      });

    const { runtime } = await agent.open({ extensions: [terminal, subagent] });
    await within(
      5000,
      "root run settles",
      (await runtime.submit("go", { requestId: "m1" })).settled(),
    );
    const delivered = await within(5000, "background sibling failure", bgDelivered.promise);
    expect(delivered).toContain('status="failed"');
    expect(delivered).toContain("bg sibling 400");
    expect(hungSignals).toHaveLength(2);
    await vi.waitFor(() => expect(hungSignals.every((s) => s.aborted)).toBe(true));
    await runtime.idle();
    agent.provider.assertComplete();
  });
});
