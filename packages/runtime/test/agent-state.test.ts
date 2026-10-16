import { describe, expect, it } from "vitest";
import { readAgentState, setAgentPaused } from "../src/index.ts";
import { testAgent } from "./support.ts";

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

describe("paused state", () => {
  it("records in the Agent file whether the Agent is paused", async () => {
    const agent = await testAgent();
    expect(await readAgentState(agent.file), "a new Agent is not paused").toEqual({
      paused: false,
    });

    await setAgentPaused(agent.file, true);
    expect(await readAgentState(agent.file)).toEqual({ paused: true });

    const opened = await agent.open();
    await opened.runtime.close();
    expect(await readAgentState(agent.file), "opening the runtime leaves it as it was").toEqual({
      paused: true,
    });

    await setAgentPaused(agent.file, false);
    expect(await readAgentState(agent.file)).toEqual({ paused: false });
  });
});
