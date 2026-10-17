import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../src/index.ts";
import { environment, ok, rendered } from "./support.ts";

describe("watching an Agent", () => {
  it("shows the model's answer while it streams, and ends the watch when the Agent is paused", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const node = await env.pairNode(admin);
    const { agentId, account } = await env.hire(admin, node.nodeId);
    const events: AgentEvent[] = [];
    const watch = await admin.watchAgent(agentId, (batch) => void events.push(...batch));
    expect(events[0]?.type, "the watch starts with a snapshot").toBe("snapshot");
    let cancelled: Promise<void> | undefined;
    env.provider.step("streaming", (request) => {
      cancelled = request.partialText("Half of my ans");
    });

    env.post("Tell me, @richard.", [account]);

    await vi.waitFor(() =>
      expect(rendered(events), "the partial answer is visible").toContain("Half of my ans"),
    );
    await admin.pauseAgent(agentId);
    await cancelled;
    await watch.ended;
  });

  it("shows tool calls with their arguments and their output as it arrives", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const node = await env.pairNode(admin);
    const { agentId, account } = await env.hire(admin, node.nodeId);
    const finish = Promise.withResolvers<void>();
    node.answer = async (call) => {
      node.node.send({
        type: "node.tool.output",
        requestId: call.requestId,
        chunk: "compiling 1/3\n",
      });
      await finish.promise;
      return { outputs: [], result: ok("compiled 3 files") };
    };
    const events: AgentEvent[] = [];
    const watch = await admin.watchAgent(agentId, (batch) => void events.push(...batch));
    env.provider
      .step(
        "build",
        (request) => void request.call([{ name: "bash", arguments: { command: "make all" } }]),
      )
      .step("done", (request) => request.text("Built."));

    env.post("Build it, @richard.", [account]);

    await vi.waitFor(() => {
      expect(
        events.filter((event) => event.type === "tool_execution_start"),
        "the call is visible while it runs",
      ).toEqual([
        expect.objectContaining({
          toolName: "bash",
          args: expect.objectContaining({ command: "make all" }),
        }),
      ]);
      expect(
        rendered(events.filter((event) => event.type === "tool_execution_update")),
        "and so is its output so far",
      ).toContain("compiling 1/3");
    });
    expect(
      events.some((event) => event.type === "tool_execution_end"),
      "still running",
    ).toBe(false);
    finish.resolve();
    await env.provider.received(2);
    await vi.waitFor(() => {
      expect(
        events.some((event) => event.type === "tool_execution_end"),
        "the call's end",
      ).toBe(true);
      expect(rendered(events), "its result").toContain("compiled 3 files");
      expect(rendered(events), "and the answer").toContain("Built.");
    });
    await watch.stop();
    env.provider.assertComplete();
  });

  it("changes nothing about the Agent by watching it", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const node = await env.pairNode(admin);
    const { agentId, account } = await env.hire(admin, node.nodeId);
    env.provider.step("first", (request) => request.text("one"));
    env.post("One, @richard.", [account]);
    await env.provider.received(1);
    await vi.waitFor(async () =>
      expect((await admin.agents())[0]).toMatchObject({
        usage: { models: { "openai/gpt-4.1": { input: 50 } } },
      }),
    );
    const before = await admin.agents();

    for (let watching = 0; watching < 3; watching++) {
      const watch = await admin.watchAgent(agentId, () => undefined);
      await watch.stop();
    }

    expect(await admin.agents(), "state, settings and usage are as they were").toEqual(before);
    expect(env.provider.requests, "the model was not called").toHaveLength(1);
    env.provider.step("second", (request) => {
      expect(
        request.userTexts().filter((text) => text.startsWith("截至 ")),
        "only the notices",
      ).toHaveLength(2);
      request.text("two");
    });
    env.post("Two, @richard.", [account]);
    await env.provider.received(2);
    env.provider.assertComplete();
  });

  it("watches a work assistant's conversation by name, and refuses one that does not exist", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const node = await env.pairNode(admin);
    const { agentId, account } = await env.hire(admin, node.nodeId);
    const helper = env.provider.lane("helper", (request) =>
      request.userTexts().includes("count the files"),
    );
    const hold = Promise.withResolvers<void>();
    helper.step("helping", async (request) => {
      await hold.promise;
      request.text("Three files.");
    });
    env.provider
      .step("delegate", (request) => {
        request.call([
          {
            name: "assistant",
            arguments: { action: "spawn", name: "counter", message: "count the files" },
          },
        ]);
      })
      .step("delegated", (request) => request.text("Asked counter."))
      .step("reported", (request) => request.text("Counter says three."));

    env.post("Count them, @richard.", [account]);
    await vi.waitFor(async () => expect(await admin.assistants(agentId)).toEqual(["counter"]));
    const events: AgentEvent[] = [];
    const watch = await admin.watchAgent(agentId, (batch) => void events.push(...batch), {
      assistant: "counter",
    });
    expect(rendered(events), "the assistant's own conversation").toContain("count the files");
    hold.resolve();
    await vi.waitFor(() => expect(rendered(events)).toContain("Three files."));
    await watch.stop();
    await expect(
      admin.watchAgent(agentId, () => undefined, { assistant: "nobody" }),
    ).rejects.toMatchObject({ reason: "unknown-assistant" });
    await env.provider.received(4);
    env.provider.assertComplete();
  });

  it("refuses to watch an Agent that is not open", async () => {
    const env = await environment();
    const admin = await env.open();
    env.useScriptedProvider(admin);
    const node = await env.pairNode(admin);
    const { agentId } = await env.hire(admin, node.nodeId);
    await admin.pauseAgent(agentId);

    await expect(admin.watchAgent(agentId, () => undefined)).rejects.toMatchObject({
      reason: "agent-closed",
    });
  });
});
