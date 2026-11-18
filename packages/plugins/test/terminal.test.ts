import {
  encodeTerminalOutcome,
  encodeTerminalWaitOutcome,
  type TerminalOutcome,
  type TerminalWaitOutcome,
  type ToolResult,
} from "@palace/node-protocol";
import { describe, expect, it } from "vitest";
import { terminalExtension, type TerminalPort } from "../src/terminal.ts";
import { testAgent, within } from "./support.ts";

class StubTerminalPort implements TerminalPort {
  readonly execCalls: (Parameters<TerminalPort["exec"]>[0] & {
    readonly onOutput: (chunk: string) => void;
    readonly signal: AbortSignal;
  })[] = [];
  readonly writeCalls: (Parameters<TerminalPort["write"]>[0] & {
    readonly signal: AbortSignal;
  })[] = [];
  readonly waitCalls: (Parameters<TerminalPort["wait"]>[0] & {
    readonly signal: AbortSignal;
    readonly resolve: (result: ToolResult) => void;
  })[] = [];

  execHandler: TerminalPort["exec"] = async (call) =>
    encodeTerminalOutcome({
      running: false,
      sessionId: call.sessionId,
      output: "ok\n",
      droppedBytes: 0,
      wallTimeMs: 5,
      ending: { kind: "exited", code: 0 },
      pipesHeld: false,
      backgroundRunning: false,
    });

  writeHandler: TerminalPort["write"] = async (call) =>
    encodeTerminalOutcome({
      running: false,
      sessionId: call.sessionId,
      output: "",
      droppedBytes: 0,
      wallTimeMs: 5,
      ending: { kind: "exited", code: 0 },
      pipesHeld: false,
      backgroundRunning: false,
    });

  waitHandler?: TerminalPort["wait"];

  async exec(
    call: Parameters<TerminalPort["exec"]>[0],
    onOutput: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    this.execCalls.push({ ...call, onOutput, signal });
    return this.execHandler(call, onOutput, signal);
  }

  async write(
    call: Parameters<TerminalPort["write"]>[0],
    onOutput: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    this.writeCalls.push({ ...call, signal });
    return this.writeHandler(call, onOutput, signal);
  }

  wait(call: Parameters<TerminalPort["wait"]>[0], signal: AbortSignal): Promise<ToolResult> {
    if (this.waitHandler !== undefined) {
      return this.waitHandler(call, signal);
    }
    const { promise, resolve } = Promise.withResolvers<ToolResult>();
    this.waitCalls.push({ ...call, signal, resolve });
    return promise;
  }

  resolveWait(sessionId: string, outcome: TerminalWaitOutcome): void {
    const index = this.waitCalls.findIndex((call) => call.sessionId === sessionId);
    if (index === -1) throw new Error(`no pending wait for ${sessionId}`);
    const [call] = this.waitCalls.splice(index, 1);
    call!.resolve(encodeTerminalWaitOutcome(outcome));
  }
}

describe("terminal extension", () => {
  it("forwards exec_command options, streams output, and interacts via write_stdin", async () => {
    const port = new StubTerminalPort();
    port.execHandler = async (call, onOutput) => {
      onOutput("chunk-1\n");
      return encodeTerminalOutcome({
        running: true,
        sessionId: call.sessionId,
        output: "chunk-1\n",
        droppedBytes: 0,
        wallTimeMs: 50,
      });
    };
    port.writeHandler = async (call) =>
      encodeTerminalOutcome({
        running: false,
        sessionId: call.sessionId,
        output: "chunk-2\n",
        droppedBytes: 0,
        wallTimeMs: 80,
        ending: { kind: "exited", code: 0 },
        pipesHeld: false,
        backgroundRunning: false,
      });

    const agent = await testAgent();
    const streamed: string[] = [];
    let sessionId = "";
    let writeOut = "";
    agent.provider
      .step("exec", (request) => {
        request.call([
          {
            name: "exec_command",
            arguments: {
              command: "python repl.py",
              workdir: "src",
              yield_time_ms: 50,
              node: "gpu",
            },
          },
        ]);
      })
      .step("write", (request) => {
        const out = request.toolOutputs()[0] ?? "";
        sessionId = /session_id:\s*(\S+?)\]/.exec(out)?.[1] ?? "";
        expect(out).toContain("chunk-1");
        request.call([
          { name: "write_stdin", arguments: { session_id: sessionId, chars: "1\n", eof: true } },
        ]);
      })
      .step("done", (request) => {
        writeOut = request.toolOutputs().at(-1) ?? "";
        request.text("finished");
      });

    const { runtime } = await agent.open({ extensions: [terminalExtension(port)] });
    await runtime.watchEvents((events) => {
      for (const event of events) {
        if (event.type === "tool_execution_update" && event.output) {
          if ("set" in event.output) streamed.push(event.output.set);
          else if (event.output.append) streamed.push(event.output.append);
        }
      }
    });

    await (await runtime.submit("run", { requestId: "m1" })).settled();
    expect(port.execCalls[0]).toMatchObject({
      command: "python repl.py",
      workdir: "src",
      yieldTimeMs: 50,
      node: "gpu",
    });
    expect(port.writeCalls[0]).toMatchObject({ sessionId, chars: "1\n", eof: true });
    expect(writeOut).toContain("chunk-2");
    expect(streamed.join("")).toContain("chunk-1");
    expect(port.waitCalls).toHaveLength(0);
    agent.provider.assertComplete();
  });

  it("wakes the conversation once on notify_on_exit completion, even across turns", async () => {
    const port = new StubTerminalPort();
    let yieldedSession = "";
    port.execHandler = async (call) => {
      yieldedSession = call.sessionId;
      return encodeTerminalOutcome({
        running: true,
        sessionId: call.sessionId,
        output: "building...\n",
        droppedBytes: 0,
        wallTimeMs: 25,
      });
    };

    const agent = await testAgent();
    const notified = Promise.withResolvers<string>();
    agent.provider
      .step("start build", (request) => {
        request.call([
          {
            name: "exec_command",
            arguments: { command: "make world", yield_time_ms: 25, notify_on_exit: true },
          },
        ]);
      })
      .step("end turn while running", (request) => {
        request.text("Build started, waiting for notification.");
      })
      .step("notified", (request) => {
        const text = request.userTexts().at(-1) ?? "";
        notified.resolve(text);
        request.text("Build finished!");
      });

    const { runtime } = await agent.open({ extensions: [terminalExtension(port)] });
    expect(await (await runtime.submit("build it", { requestId: "m1" })).settled()).toBe("done");
    await within(
      2000,
      "wait call registered",
      new Promise<void>((resolve) => {
        const check = () => (port.waitCalls.length > 0 ? resolve() : setTimeout(check, 5));
        check();
      }),
    );

    const finalOutcome: TerminalOutcome = {
      running: false,
      sessionId: yieldedSession,
      output: "built 10/10\n",
      droppedBytes: 0,
      wallTimeMs: 500,
      ending: { kind: "exited", code: 0 },
      pipesHeld: false,
      backgroundRunning: false,
    };
    port.resolveWait(yieldedSession, { consumed: false, outcome: finalOutcome });

    const body = await within(2000, "notification delivered", notified.promise);
    expect(body).toContain("<command_notification");
    expect(body).toContain('status="completed"');
    expect(body).toContain("built 10/10");
    await runtime.idle();
    agent.provider.assertComplete();
  });

  it("suppresses duplicate command_notification when write_stdin observes exit first", async () => {
    const port = new StubTerminalPort();
    let yieldedSession = "";
    port.execHandler = async (call) => {
      yieldedSession = call.sessionId;
      return encodeTerminalOutcome({
        running: true,
        sessionId: call.sessionId,
        output: "",
        droppedBytes: 0,
        wallTimeMs: 10,
      });
    };
    port.writeHandler = async (call) => {
      // Simulate single-consumer: node returns { consumed: true } to wait caller while returning outcome to write.
      if (port.waitCalls.some((w) => w.sessionId === call.sessionId)) {
        port.resolveWait(call.sessionId, { consumed: true });
      }
      return encodeTerminalOutcome({
        running: false,
        sessionId: call.sessionId,
        output: "early exit\n",
        droppedBytes: 0,
        wallTimeMs: 40,
        ending: { kind: "exited", code: 0 },
        pipesHeld: false,
        backgroundRunning: false,
      });
    };

    const agent = await testAgent();
    agent.provider
      .step("start", (request) => {
        request.call([
          {
            name: "exec_command",
            arguments: { command: "quick.sh", yield_time_ms: 10, notify_on_exit: true },
          },
        ]);
      })
      .step("check with write_stdin", (request) => {
        request.call([{ name: "write_stdin", arguments: { session_id: yieldedSession } }]);
      })
      .step("ack", (request) => {
        expect(request.toolOutputs().at(-1)).toContain("early exit");
        request.text("Already finished.");
      });

    const { runtime } = await agent.open({ extensions: [terminalExtension(port)] });
    await (await runtime.submit("run", { requestId: "m1" })).settled();
    await runtime.idle();
    expect(agent.provider.requests).toHaveLength(3);
    agent.provider.assertComplete();
  });

  it("arms notify_on_exit idempotently from write_stdin and delivers lost notice on reopen", async () => {
    const port = new StubTerminalPort();
    let yieldedSession = "";
    port.execHandler = async (call) => {
      yieldedSession = call.sessionId;
      return encodeTerminalOutcome({
        running: true,
        sessionId: call.sessionId,
        output: "",
        droppedBytes: 0,
        wallTimeMs: 10,
      });
    };
    port.writeHandler = async (call) =>
      encodeTerminalOutcome({
        running: true,
        sessionId: call.sessionId,
        output: "",
        droppedBytes: 0,
        wallTimeMs: 20,
      });

    const agent = await testAgent();
    agent.provider
      .step("start", (request) => {
        request.call([
          { name: "exec_command", arguments: { command: "long.sh", yield_time_ms: 10 } },
        ]);
      })
      .step("arm twice", (request) => {
        request.call([
          { name: "write_stdin", arguments: { session_id: yieldedSession, notify_on_exit: true } },
          { name: "write_stdin", arguments: { session_id: yieldedSession, notify_on_exit: true } },
        ]);
      })
      .step("done", (request) => request.text("armed"));

    const first = await agent.open({ extensions: [terminalExtension(port)] });
    await (await first.runtime.submit("go", { requestId: "m1" })).settled();
    expect(port.waitCalls).toHaveLength(1);
    await first.runtime.close();

    // After reopen, node/gateway no longer has the session and rejects wait with lost error.
    const reopenedPort = new StubTerminalPort();
    reopenedPort.waitHandler = async (call) => ({
      content: [{ type: "text", text: `Terminal session ${call.sessionId} lost` }],
      isError: true,
    });
    const lost = Promise.withResolvers<string>();
    agent.provider.step("lost notified", (request) => {
      const text = request.userTexts().at(-1) ?? "";
      lost.resolve(text);
      request.text("I will restart it.");
    });
    const second = await agent.open({ extensions: [terminalExtension(reopenedPort)] });
    const message = await within(2000, "lost notification delivered", lost.promise);
    expect(message).toContain("<command_notification");
    expect(message).toContain('status="lost"');
    await second.runtime.idle();
    agent.provider.assertComplete();
  });
});
