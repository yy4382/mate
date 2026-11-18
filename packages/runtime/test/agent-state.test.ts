import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { configureAgentFile, readAgentFile, withAgentFileSession } from "../src/index.ts";
import { defaultSettings, testAgent } from "./support.ts";

const SampleDoc = defineDoc<{ label: string; count: number }>({
  kind: "test.sample",
  version: 1,
  scope: "session",
  initial: () => ({ label: "", count: 0 }),
});

describe("session documents on an open runtime", () => {
  it("reads and commits custom documents across a reopen", async () => {
    const agent = await testAgent(defaultSettings, {
      init: async (tx) => {
        (await tx.doc(SampleDoc)).label = "alpha";
      },
    });
    const first = await agent.open();
    expect(await first.runtime.snapshot(SampleDoc)).toEqual({ label: "alpha", count: 0 });

    await first.runtime.commit(async (tx) => {
      (await tx.doc(SampleDoc)).count = 7;
    });
    expect(await first.runtime.snapshot(SampleDoc)).toEqual({ label: "alpha", count: 7 });
    await first.runtime.close();

    const second = await agent.open();
    expect(await second.runtime.snapshot(SampleDoc)).toEqual({ label: "alpha", count: 7 });
  });
});

describe("a closed Agent's file", () => {
  it("lets callers read and write custom documents while closed", async () => {
    const agent = await testAgent(defaultSettings, {
      init: async (tx) => {
        (await tx.doc(SampleDoc)).label = "beta";
      },
    });
    expect(
      (await readAgentFile(agent.file, (s) => s.snapshot(SampleDoc, BACKGROUND_CONTEXT))).extra,
    ).toEqual({ label: "beta", count: 0 });

    await withAgentFileSession(agent.file, (session) =>
      session.commit(async (tx) => {
        (await tx.doc(SampleDoc)).count = 3;
      }, BACKGROUND_CONTEXT),
    );

    expect(
      (await readAgentFile(agent.file, (s) => s.snapshot(SampleDoc, BACKGROUND_CONTEXT))).extra,
    ).toEqual({ label: "beta", count: 3 });

    const opened = await agent.open();
    expect(await opened.runtime.snapshot(SampleDoc)).toEqual({ label: "beta", count: 3 });
  });

  it("holds settings and usage, as the open runtime reports them", async () => {
    const agent = await testAgent({ ...defaultSettings, instructions: "Be brief." });
    agent.provider.step("answer", (request) => request.text("hi", { inputTokens: 120 }));
    const { runtime } = await agent.open();
    await (await runtime.submit("hello", { requestId: "m1" })).settled();
    const settings = await runtime.settings();
    const usage = await runtime.usage();
    await runtime.close();

    expect(settings).toEqual({ ...defaultSettings, instructions: "Be brief." });
    expect(await readAgentFile(agent.file)).toEqual({
      settings,
      usage,
      extra: undefined,
    });
    expect(usage.models["openai/gpt-4.1"]).toMatchObject({ input: 120, output: 10 });
  });

  it("takes new settings while closed, and the reopened runtime's next request uses them", async () => {
    const agent = await testAgent();
    agent.provider.step("after", (request) => request.text("b"));
    const changed = {
      model: { provider: "openai", modelId: "gpt-5-mini" },
      thinkingLevel: "high",
    } as const;

    await configureAgentFile(agent.file, changed);

    expect((await readAgentFile(agent.file)).settings).toEqual(changed);
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
