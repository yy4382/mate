import { Type } from "@earendil-works/pi-ai";
import {
  CompactionEntry,
  defineExtension,
  defineTool,
  type AgentEvent,
} from "@earendil-works/pi-durable";
import type { AgentRuntime, AgentSettings } from "@palace/runtime";
import type { ScriptedRequest } from "@palace/testkit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { historyExtension } from "../src/history.ts";
import { idleCompaction } from "../src/idle-compaction.ts";
import { FakeClock, defaultSettings, testAgent, within, type PluginTestAgent } from "./support.ts";

const sol: AgentSettings = { model: { provider: "openai", modelId: "gpt-6.1-sol" } };
const MINUTE = 60_000;
const PAST = 5_000;
const CHECKPOINT =
  "CHECKPOINT: the build failed on the disk quota of /var/build; next, free space.";

function dummyTool(onCall?: () => Promise<string>) {
  return defineExtension({
    name: "dummy",
    tools: [
      defineTool({
        name: "run_step",
        description: "Run step.",
        parameters: Type.Object({ input: Type.String() }),
        replay: "safe",
        execute: async () => ({
          content: [{ type: "text", text: onCall === undefined ? "hi" : await onCall() }],
        }),
      }),
    ],
  });
}

async function idleAgent(tokens = 148_566, settings: AgentSettings = sol, padding = "") {
  const clock = new FakeClock(Date.now());
  const makeCompact = () => idleCompaction();
  const initialCompact = makeCompact();
  const agent = await testAgent(settings, {
    clock,
    defaultExtensions: () => [historyExtension, initialCompact.extension, dummyTool()],
    defaultBackground: () => [initialCompact.background],
  });
  agent.provider.step("answers", (request) =>
    request.text(`The build failed: disk quota exceeded on /var/build.${padding}`, {
      inputTokens: tokens,
    }),
  );
  agent.provider.lane("summaries", (request) => request.toolNames().length === 0);
  const first = await agent.open();
  await (await first.runtime.submit("check the build", { requestId: "m1" })).settled();
  const resting = () => clock.resting();
  await resting();
  const answered = await answeredAt(first.runtime);
  const idleFor = (ms: number) => clock.advance(answered + ms - clock.now());
  return { agent, clock, first, resting, idleFor, makeCompact };
}

async function answeredAt(runtime: AgentRuntime): Promise<number> {
  let stamp: number | undefined;
  const watch = await runtime.watchEvents((events) => {
    for (const event of events)
      if (event.type === "snapshot")
        for (const entry of event.entries) {
          const [message] = entry.model ?? [];
          if (message?.role === "assistant") stamp = message.timestamp;
        }
  });
  await watch.stop();
  if (stamp === undefined) throw new Error("no answer to count the idle time from");
  return stamp;
}

const requestOf = (agent: PluginTestAgent, step: string): ScriptedRequest => {
  const found = agent.provider.requests.find((request) => request.step === step);
  if (found === undefined) throw new Error(`no request for step ${step}`);
  return found;
};

async function compaction(runtime: AgentRuntime): Promise<void> {
  const found = Promise.withResolvers<void>();
  const isMarker = (events: readonly AgentEvent[]) =>
    events.some((event) =>
      event.type === "snapshot"
        ? event.entries.some((entry) => CompactionEntry.is(entry))
        : event.type === "message_end" && CompactionEntry.is(event.entry),
    );
  const watch = await runtime.watchEvents((events) => {
    if (isMarker(events)) found.resolve();
  });
  try {
    await within(5000, "the compaction", found.promise);
  } finally {
    await watch.stop();
  }
}

async function expectContextKept(agent: PluginTestAgent, runtime: AgentRuntime) {
  agent.provider.step("works on", (request) => {
    const answered = requestOf(agent, "answers").body;
    expect(request.body.input.slice(0, answered.input.length)).toEqual(answered.input);
    expect(request.userTexts()).toEqual(["check the build", "what next?"]);
    request.text("Free some space.");
  });
  await (await runtime.submit("what next?", { requestId: "next" })).settled();
  agent.provider.assertComplete();
}

const HistoryPage = z.object({
  inContextFrom: z.number(),
  records: z.array(z.object({ n: z.number(), text: z.string() })),
});

describe("idle compaction", () => {
  it("asks an idle Agent past two thirds of its Durable compaction line for a checkpoint that continues its cached request, then works on from that checkpoint", async () => {
    const { agent, first, idleFor } = await idleAgent();
    agent.provider.step("checkpoint", (request) => {
      const answered = requestOf(agent, "answers").body;
      expect(request.body.instructions).toEqual(answered.instructions);
      expect(request.body.tools).toEqual(answered.tools);
      expect(request.body.prompt_cache_key).toBeDefined();
      expect(request.body.prompt_cache_key).toBe(answered.prompt_cache_key);
      expect(request.body.input.slice(0, answered.input.length)).toEqual(answered.input);
      expect(request.userTexts().at(-1)).toContain("checkpoint summary");
      request.text(CHECKPOINT);
    });
    let searched = "";
    agent.provider
      .step("works from the checkpoint", (request) => {
        expect(request.userTexts()).toEqual([expect.stringContaining("compacted"), "what next?"]);
        const input = JSON.stringify(request.body.input);
        expect(input).toContain(CHECKPOINT);
        expect(input).not.toContain("check the build");
        [searched = ""] = request.call([
          { name: "history_search", arguments: { query: "check the build" } },
        ]);
      })
      .step("answers from the history", (request) => {
        const page = HistoryPage.parse(JSON.parse(request.toolOutput(searched) ?? "null"));
        const [hit] = page.records;
        expect(hit?.text).toContain("check the build");
        expect(hit?.n).toBeLessThan(page.inContextFrom);
        request.text("Free some space on /var/build.");
      });

    const compacted = compaction(first.runtime);
    idleFor(25 * MINUTE + PAST);
    await compacted;
    await (await first.runtime.submit("what next?", { requestId: "m2" })).settled();

    expect(agent.provider.requests.map(({ step }) => step)).toEqual([
      "answers",
      "checkpoint",
      "works from the checkpoint",
      "answers from the history",
    ]);
    agent.provider.assertComplete();
  });

  const quiet: [string, () => ReturnType<typeof idleAgent>, number][] = [
    [
      "its last request read less than two thirds of Durable's compaction line",
      () => idleAgent(148_565),
      25 * MINUTE + PAST,
    ],
    ["the delay has not passed", () => idleAgent(), 24 * MINUTE],
    [
      "a model without its own entry read less than the default 200k tokens",
      () => idleAgent(199_999, defaultSettings),
      25 * MINUTE + PAST,
    ],
  ];
  it.each(quiet)("does nothing when %s", async (_why, setup, delay) => {
    const { agent, first, resting, idleFor } = await setup();

    idleFor(delay);
    await resting();

    await expectContextKept(agent, first.runtime);
  });

  it("declines once and never retries when checkpoint calls a tool", async () => {
    const { agent, clock, first, resting, idleFor } = await idleAgent();
    agent.provider
      .step("checkpoint", (request) => {
        request.call([{ name: "run_step", arguments: { input: "echo hi" } }]);
      })
      .step("checkpoint after tool", (request) => request.text(CHECKPOINT));

    idleFor(25 * MINUTE + PAST);
    await within(2000, "the checkpoint request", agent.provider.received(2));
    await first.runtime.idle();
    await resting();

    clock.advance(25 * MINUTE + PAST);
    await resting();

    agent.provider.step("works on", (request) => {
      const answered = requestOf(agent, "answers").body;
      expect(request.body.input.slice(0, answered.input.length)).toEqual(answered.input);
      expect(request.userTexts().slice(-1)).toEqual(["what next?"]);
      request.text("Free some space.");
    });
    await (await first.runtime.submit("what next?", { requestId: "next" })).settled();
    agent.provider.assertComplete();
  });

  it("asks once and still compacts when the process dies between the checkpoint answer and compaction", async () => {
    const { agent, first, idleFor, makeCompact } = await idleAgent();
    agent.provider.step("checkpoint", (request) => request.text(CHECKPOINT));
    const died = first
      .database()
      .freezeAfter(
        (sql, params) =>
          sql.startsWith("INSERT INTO entries") &&
          params.some((param) => typeof param === "string" && param.includes(CHECKPOINT)),
      );

    idleFor(25 * MINUTE + PAST);
    await within(2000, "the checkpoint answer's commit", died);

    const c2 = makeCompact();
    const second = await agent.open({
      extensions: [historyExtension, c2.extension, dummyTool()],
      background: [c2.background],
    });
    await compaction(second.runtime);
    agent.provider.step("works from checkpoint", (request) => {
      expect(request.userTexts()).toEqual([expect.stringContaining("compacted"), "what next?"]);
      expect(JSON.stringify(request.body.input)).toContain(CHECKPOINT);
      request.text("Free some space.");
    });
    await (await second.runtime.submit("what next?", { requestId: "m2" })).settled();

    expect(agent.provider.requests.map(({ step }) => step)).toEqual([
      "answers",
      "checkpoint",
      "works from checkpoint",
    ]);
    agent.provider.assertComplete();
  });

  it("omits history_search hint when history extension is not installed", async () => {
    const clock = new FakeClock(Date.now());
    const compact = idleCompaction();
    const agent = await testAgent(sol, {
      clock,
      defaultExtensions: () => [compact.extension],
      defaultBackground: () => [compact.background],
    });
    agent.provider.step("answers", (request) =>
      request.text("Build failed.", { inputTokens: 148_566 }),
    );
    const { runtime } = await agent.open();
    await (await runtime.submit("check", { requestId: "m1" })).settled();
    await clock.resting();
    const stamped = await answeredAt(runtime);
    agent.provider
      .step("checkpoint", (request) => request.text(CHECKPOINT))
      .step("after compact", (request) => {
        const note = request.userTexts()[0] ?? "";
        expect(note).toContain("compacted");
        expect(note).not.toContain("history_search");
        request.text("continuing");
      });
    const compacted = compaction(runtime);
    clock.advance(stamped + 25 * MINUTE + PAST - clock.now());
    await compacted;
    await (await runtime.submit("next", { requestId: "m2" })).settled();
    agent.provider.assertComplete();
  });
});
