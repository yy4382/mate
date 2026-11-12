import { CompactionEntry, type AgentEvent } from "@earendil-works/pi-durable";
import type { ScriptedRequest } from "@palace/testkit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FakeClock,
  defaultSettings,
  said,
  testAgent,
  text,
  within,
  type TestAgent,
} from "./support.ts";
import type { AgentRuntime, AgentSettings } from "../src/index.ts";

/** In pi-ai's catalog, on the Responses API the scripted provider speaks. Its idle delay is 25 minutes. */
const sol: AgentSettings = { model: { provider: "openai", modelId: "gpt-6.1-sol" } };
const MINUTE = 60_000;
/**
 * pi-ai stamps an answer with the wall clock at its request's start, and the fake clock starts at the wall clock, so a
 * few seconds past the delay is past it for any answer of the test.
 */
const PAST = 5_000;
const CHECKPOINT =
  "CHECKPOINT: the build failed on the disk quota of /var/build; next, free space.";

/**
 * An Agent on gpt-6.1-sol that checked the build, its answer read `tokens` of input. Durable's summarizer requests go
 * to `summaries`, which has no steps: any request there fails `assertComplete()`.
 */
async function idleAgent(tokens = 200_000, settings: AgentSettings = sol) {
  const clock = new FakeClock(Date.now());
  const agent = await testAgent(settings, { clock });
  agent.workspace.answerAll(() => text("hi"));
  agent.provider.step("answers", (request) =>
    request.text("The build failed: disk quota exceeded on /var/build.", { inputTokens: tokens }),
  );
  agent.provider.lane("summaries", (request) => request.toolNames().length === 0);
  const first = await agent.open();
  await (await first.runtime.submit(said.input("m1", "check the build"))).settled();
  // The reminder loop and the idle compaction loop both asleep: nothing more happens until time moves or input comes.
  const resting = () => clock.sleeping(2);
  await resting();
  return { agent, clock, first, resting };
}

const requestOf = (agent: TestAgent, step: string): ScriptedRequest => {
  const found = agent.provider.requests.find((request) => request.step === step);
  if (found === undefined) throw new Error(`no request for step ${step}`);
  return found;
};

/** Resolves once the primary conversation holds a compaction marker. */
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

/** The next input's request carries the context unchanged: no checkpoint was asked and nothing was compacted. */
async function expectContextKept(agent: TestAgent, runtime: AgentRuntime) {
  agent.provider.step("works on", (request) => {
    const answered = requestOf(agent, "answers").body;
    expect(
      request.body.input.slice(0, answered.input.length),
      "the request continues the answered one",
    ).toEqual(answered.input);
    expect(request.userTexts()).toEqual(["check the build", "what next?"]);
    request.text("Free some space.");
  });
  await (await runtime.submit(said.input("next", "what next?"))).settled();
  agent.provider.assertComplete();
}

const HistoryPage = z.object({
  inContextFrom: z.number(),
  records: z.array(z.object({ n: z.number(), text: z.string() })),
});

describe("idle compaction", () => {
  it("asks an idle Agent over 200k tokens for a checkpoint that continues its cached request, then works on from that checkpoint", async () => {
    const { agent, clock, first } = await idleAgent();
    agent.provider.step("checkpoint", (request) => {
      const answered = requestOf(agent, "answers").body;
      expect(request.body.instructions, "the same instructions").toEqual(answered.instructions);
      expect(request.body.tools, "the same tools").toEqual(answered.tools);
      expect(request.body.prompt_cache_key, "the conversation's cache key").toBeDefined();
      expect(request.body.prompt_cache_key).toBe(answered.prompt_cache_key);
      expect(
        request.body.input.slice(0, answered.input.length),
        "the input starts with the answered request's input",
      ).toEqual(answered.input);
      expect(request.userTexts().at(-1), "and ends asking for a checkpoint").toContain(
        "checkpoint summary",
      );
      request.text(CHECKPOINT);
    });
    let searched = "";
    agent.provider
      .step("works from the checkpoint", (request) => {
        expect(request.userTexts(), "a note, then the new input").toEqual([
          expect.stringContaining("compacted"),
          "what next?",
        ]);
        const input = JSON.stringify(request.body.input);
        expect(input, "the checkpoint answer is the context").toContain(CHECKPOINT);
        expect(input, "the compacted records are out of it").not.toContain("check the build");
        expect(input).not.toContain("disk quota exceeded");
        [searched = ""] = request.call([
          { name: "history_search", arguments: { query: "check the build" } },
        ]);
      })
      .step("answers from the history", (request) => {
        const page = HistoryPage.parse(JSON.parse(request.toolOutput(searched) ?? "null"));
        const [hit] = page.records;
        expect(hit?.text, "the compacted input is still found").toContain("check the build");
        expect(hit?.n, "before the context").toBeLessThan(page.inContextFrom);
        request.text("Free some space on /var/build.");
      });

    const compacted = compaction(first.runtime);
    clock.advance(25 * MINUTE + PAST);
    await compacted;
    await (await first.runtime.submit(said.input("m2", "what next?"))).settled();

    expect(
      agent.provider.requests.map(({ step }) => step),
      "one checkpoint request, and no request of Durable's summarizer",
    ).toEqual(["answers", "checkpoint", "works from the checkpoint", "answers from the history"]);
    agent.provider.assertComplete();
  });

  const quiet: [string, () => ReturnType<typeof idleAgent>, number][] = [
    ["its last request read less than 200k tokens", () => idleAgent(199_999), 25 * MINUTE + PAST],
    ["the delay has not passed", () => idleAgent(), 24 * MINUTE],
    ["its model has no idle delay", () => idleAgent(200_000, defaultSettings), 25 * MINUTE + PAST],
  ];
  it.each(quiet)("asks nothing when %s", async (_when, open, idle) => {
    const { agent, clock, first, resting } = await open();
    clock.advance(idle);
    await resting();
    await expectContextKept(agent, first.runtime);
  });

  it("asks nothing when the Agent's model changed since its last request", async () => {
    const { agent, clock, first, resting } = await idleAgent();
    await first.runtime.configure(defaultSettings);
    clock.advance(25 * MINUTE + PAST);
    await resting();
    agent.provider.step("works on", (request) => {
      // gpt-4.1 takes the prompt as a system message where gpt-6.1-sol takes a developer one, so only inputs compare.
      expect(request.userTexts()).toEqual(["check the build", "what next?"]);
      request.text("Free some space.");
    });
    await (await first.runtime.submit(said.input("next", "what next?"))).settled();
    agent.provider.assertComplete();
  });

  it("asks nothing when the Agent is reopened after its cache is gone", async () => {
    const { agent, clock, first } = await idleAgent();
    await first.runtime.close();
    clock.advance(31 * MINUTE);
    const second = await agent.open();
    await clock.sleeping(2);
    await expectContextKept(agent, second.runtime);
  });

  it("keeps counting the delay from the last request across a close and reopen", async () => {
    const { agent, clock, first } = await idleAgent();
    clock.advance(20 * MINUTE);
    await first.runtime.close();
    agent.provider.step("checkpoint", (request) => request.text(CHECKPOINT));
    const second = await agent.open();
    const compacted = compaction(second.runtime);

    clock.advance(5 * MINUTE + PAST);

    await compacted;
    expect(agent.provider.requests.map(({ step }) => step)).toEqual(["answers", "checkpoint"]);
    agent.provider.assertComplete();
  });

  it("asks only after a run in progress at the delay ends, continuing that run's request", async () => {
    const { agent, clock, first } = await idleAgent();
    const release = Promise.withResolvers<void>();
    agent.provider.step("long run", async (request) => {
      await release.promise;
      request.text("Checked again.", { inputTokens: 200_000 });
    });
    agent.provider.step("checkpoint", (request) => {
      const previous = requestOf(agent, "long run").body;
      expect(request.body.input.slice(0, previous.input.length)).toEqual(previous.input);
      expect(request.userTexts().slice(0, -1)).toEqual(["check the build", "check again"]);
      request.text(CHECKPOINT);
    });
    await first.runtime.submit(said.input("m2", "check again"));
    await within(2000, "the long run's request", agent.provider.received(2));
    const compacted = compaction(first.runtime);

    clock.advance(25 * MINUTE + PAST);
    release.resolve();

    await compacted;
    agent.provider.assertComplete();
  });

  const declined: [string, (agent: TestAgent) => void][] = [
    [
      "calls a tool",
      (agent) =>
        agent.provider
          .step("checkpoint", (request) => {
            request.call([{ name: "bash", arguments: { command: "echo hi" } }]);
          })
          .step("checkpoint after the tool", (request) => request.text(CHECKPOINT)),
    ],
    [
      "is cut off at its token limit",
      (agent) =>
        agent.provider.step("checkpoint", (request) =>
          request.text("CHECKPOINT: the bui", { truncated: true }),
        ),
    ],
  ];
  it.each(declined)(
    "compacts nothing, and never asks again, when the checkpoint answer %s",
    async (_when, script) => {
      const { agent, clock, first, resting } = await idleAgent();
      script(agent);
      clock.advance(25 * MINUTE + PAST);
      await within(2000, "the checkpoint request", agent.provider.received(2));
      await first.runtime.idle();
      await resting();

      clock.advance(25 * MINUTE + PAST);
      await resting();

      agent.provider.step("works on", (request) => {
        const answered = requestOf(agent, "answers").body;
        expect(
          request.body.input.slice(0, answered.input.length),
          "the context is kept, the checkpoint exchange included",
        ).toEqual(answered.input);
        expect(request.userTexts().slice(-1)).toEqual(["what next?"]);
        expect(
          request.userTexts().filter((each) => each.includes("checkpoint summary")),
        ).toHaveLength(1);
        request.text("Free some space.");
      });
      await (await first.runtime.submit(said.input("next", "what next?"))).settled();
      agent.provider.assertComplete();
    },
  );

  it("asks once and still compacts when the process dies between the checkpoint answer and the compaction", async () => {
    const { agent, clock, first } = await idleAgent();
    agent.provider.step("checkpoint", (request) => request.text(CHECKPOINT));
    const died = first
      .database()
      .freezeAfter(
        (sql, params) =>
          sql.startsWith("INSERT INTO entries") &&
          params.some((param) => typeof param === "string" && param.includes(CHECKPOINT)),
      );

    clock.advance(25 * MINUTE + PAST);
    await within(2000, "the checkpoint answer's commit", died);

    const second = await agent.open();
    await compaction(second.runtime);
    agent.provider.step("works from the checkpoint", (request) => {
      expect(request.userTexts()).toEqual([expect.stringContaining("compacted"), "what next?"]);
      expect(JSON.stringify(request.body.input)).toContain(CHECKPOINT);
      request.text("Free some space.");
    });
    await (await second.runtime.submit(said.input("m2", "what next?"))).settled();

    expect(
      agent.provider.requests.map(({ step }) => step),
      "the checkpoint was asked once",
    ).toEqual(["answers", "checkpoint", "works from the checkpoint"]);
    agent.provider.assertComplete();
  });

  it("answers a real input that arrives during the checkpoint request after it, and compacts with that input kept", async () => {
    const { agent, clock, first } = await idleAgent();
    agent.provider
      .step("checkpoint", async (request) => {
        await first.runtime.submit(said.input("m2", "and the tests?"));
        request.text(CHECKPOINT);
      })
      .step("answers the real input", (request) => {
        expect(request.userTexts().slice(-1)).toEqual(["and the tests?"]);
        expect(JSON.stringify(request.body.input)).toContain(CHECKPOINT);
        request.text("The tests passed.");
      });
    const compacted = compaction(first.runtime);

    clock.advance(25 * MINUTE + PAST);
    await compacted;
    await first.runtime.idle();
    agent.provider.step("works from the checkpoint", (request) => {
      expect(request.userTexts(), "the note, the real input, the new one").toEqual([
        expect.stringContaining("compacted"),
        "and the tests?",
        "what next?",
      ]);
      const input = JSON.stringify(request.body.input);
      expect(input).toContain(CHECKPOINT);
      expect(input).toContain("The tests passed.");
      expect(input).not.toContain("check the build");
      request.text("Free some space.");
    });
    await (await first.runtime.submit(said.input("m3", "what next?"))).settled();
    agent.provider.assertComplete();
  });
});
