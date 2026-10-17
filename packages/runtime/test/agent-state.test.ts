import { describe, expect, it } from "vitest";
import { configureAgentFile, readAgentState, setAgentPaused } from "../src/index.ts";
import { defaultSettings, testAgent } from "./support.ts";

describe("cursors", () => {
  it("keeps a cursor across a reopen and never moves it back", async () => {
    const agent = await testAgent();
    const first = await agent.open();
    expect(await first.runtime.cursor("chat-inbox"), "a new cursor starts at 0").toBe(0);

    await first.runtime.advanceCursor("chat-inbox", 7);
    await first.runtime.advanceCursor("chat-inbox", 3);
    expect(await first.runtime.cursor("chat-inbox"), "advancing to a lower value is a no-op").toBe(
      7,
    );
    expect(await first.runtime.cursor("other"), "cursors are independent").toBe(0);
    await first.runtime.close();

    const second = await agent.open();
    expect(await second.runtime.cursor("chat-inbox"), "the cursor survives a reopen").toBe(7);
  });
});

describe("a closed Agent's file", () => {
  it("records whether the Agent is paused", async () => {
    const agent = await testAgent();
    expect(await readAgentState(agent.file), "a new Agent is not paused").toMatchObject({
      paused: false,
    });

    await setAgentPaused(agent.file, true);
    expect(await readAgentState(agent.file)).toMatchObject({ paused: true });

    const opened = await agent.open();
    await opened.runtime.close();
    expect(
      await readAgentState(agent.file),
      "opening the runtime leaves it as it was",
    ).toMatchObject({ paused: true });

    await setAgentPaused(agent.file, false);
    expect(await readAgentState(agent.file)).toMatchObject({ paused: false });
  });

  it("holds the node the Agent was created on, its settings and its usage, as the open runtime reports them", async () => {
    const agent = await testAgent({ ...defaultSettings, instructions: "Be brief." });
    agent.provider.step("answer", (request) => request.text("hi", { inputTokens: 120 }));
    const { runtime } = await agent.open();
    await (await runtime.submit("hello", { requestId: "m1" })).settled();
    const settings = await runtime.settings();
    const usage = await runtime.usage();
    await runtime.close();

    expect(settings, "the open runtime reports its settings").toEqual({
      ...defaultSettings,
      instructions: "Be brief.",
    });
    expect(await readAgentState(agent.file)).toEqual({
      paused: false,
      nodeId: "node-1",
      settings,
      usage,
    });
    expect(usage.models["openai/gpt-4.1"], "the usage is the response's").toMatchObject({
      input: 120,
      output: 10,
    });
  });

  it("takes new settings while closed, and the reopened runtime's next request uses them", async () => {
    const agent = await testAgent();
    agent.provider.step("after", (request) => request.text("b"));
    const changed = {
      model: { provider: "openai", modelId: "gpt-5-mini" },
      thinkingLevel: "high",
    } as const;

    await configureAgentFile(agent.file, changed);

    expect((await readAgentState(agent.file)).settings).toEqual(changed);
    const { runtime } = await agent.open();
    expect(await runtime.settings()).toEqual(changed);
    await (await runtime.submit("two", { requestId: "m2" })).settled();
    expect(
      agent.provider.requests.map(({ body }) => [body.model, body.reasoning]),
      "the request carries the settings written while closed",
    ).toEqual([["gpt-5-mini", expect.objectContaining({ effort: "high" })]]);
    agent.provider.assertComplete();
  });
});
