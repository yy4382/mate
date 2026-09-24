import { expect, it } from "vitest";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { answer, deferred, model, scripted } from "../helpers/pi.js";

function setup(execute: () => void) {
  const tool: AgentTool = {
    name: "probe",
    label: "probe",
    description: "Synthetic probe",
    parameters: Type.Object({}),
    execute: async () => {
      execute();
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };
  return new Agent({
    initialState: { systemPrompt: "trusted", model, tools: [tool] },
    toolExecution: "sequential",
    streamFn: scripted([
      answer([{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }], "toolUse"),
      answer([{ type: "text", text: "done" }]),
    ]),
  });
}
it("awaits durable message_end before tools and agent_end before idle", async () => {
  let executed = false;
  const agent = setup(() => {
    executed = true;
  });
  const reached = deferred(),
    saved = deferred(),
    ended = deferred(),
    endSaved = deferred();
  agent.subscribe(async (e) => {
    if (
      e.type === "message_end" &&
      e.message.role === "assistant" &&
      e.message.stopReason === "toolUse"
    ) {
      reached.resolve();
      await saved.promise;
    }
    if (e.type === "agent_end") {
      ended.resolve();
      await endSaved.promise;
    }
  });
  const run = agent.prompt("run");
  await reached.promise;
  expect(executed).toBe(false);
  await expect(agent.prompt("overlap")).rejects.toThrow();
  saved.resolve();
  await ended.promise;
  expect(executed).toBe(true);
  expect(agent.state.isStreaming).toBe(true);
  endSaved.resolve();
  await run;
  await agent.waitForIdle();
  expect(agent.state.isStreaming).toBe(false);
});
it("a persistence failure prevents tool execution, but prompt resolution alone is not success", async () => {
  let executed = false;
  const agent = setup(() => {
    executed = true;
  });
  agent.subscribe((e) => {
    if (
      e.type === "message_end" &&
      e.message.role === "assistant" &&
      e.message.stopReason === "toolUse"
    )
      throw new Error("disk full");
  });
  await agent.prompt("run");
  expect(executed).toBe(false);
  expect(agent.state.errorMessage).toBe("disk full");
});
it("persistent storage failure rejects prompt even though idle settles and errorMessage is empty", async () => {
  let executed = false;
  const agent = setup(() => {
    executed = true;
  });
  agent.subscribe((e) => {
    if (e.type === "message_end") throw new Error("persistent disk full");
  });
  await expect(agent.prompt("run")).rejects.toThrow("persistent disk full");
  await agent.waitForIdle();
  expect(agent.state.isStreaming).toBe(false);
  expect(agent.state.errorMessage).toBeUndefined();
  expect(executed).toBe(false);
});
it("restored transcript retains system/tool declarations and crosses channels", async () => {
  const first = setup(() => {});
  await first.prompt("channel A: constraint");
  const messages = JSON.parse(JSON.stringify(first.state.messages)) as AgentMessage[];
  const second = new Agent({
    initialState: {
      messages,
      model,
      systemPrompt: "must not silently overwrite",
    },
    streamFn: scripted([answer([{ type: "text", text: "continued" }])]),
    sessionId: "logical-one",
  });
  await second.prompt("channel B: continue");
  expect(second.state.messages[0]).toEqual(messages[0]);
  expect(JSON.stringify(second.state.messages)).toContain("channel A: constraint");
  expect(second.state.systemPrompt).toBe("trusted");
});
it("abort propagates to the running tool and settles without another model request", async () => {
  const started = deferred();
  let aborted = false;
  const tool: AgentTool = {
    name: "slow",
    label: "slow",
    description: "Abort probe",
    parameters: Type.Object({}),
    execute: async (_id, _args, signal) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      aborted = true;
      return { content: [{ type: "text", text: "cancelled" }], details: {} };
    },
  };
  const agent = new Agent({
    initialState: { model, tools: [tool] },
    toolExecution: "sequential",
    streamFn: scripted([
      answer([{ type: "toolCall", id: "slow-1", name: "slow", arguments: {} }], "toolUse"),
    ]),
  });
  const run = agent.prompt("work");
  await started.promise;
  agent.abort();
  await run;
  expect(aborted).toBe(true);
  expect(agent.state.isStreaming).toBe(false);
  expect(agent.state.messages.at(-1)).toMatchObject({
    role: "assistant",
    stopReason: "aborted",
  });
});
