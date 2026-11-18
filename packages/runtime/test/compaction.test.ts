import type { ScriptedRequest, ScriptedRequestBody } from "@palace/testkit";
import { describe, expect, it } from "vitest";
import { defaultSettings, testAgent, within } from "./support.ts";

const contextWindow = 100_000;
const log = (first: string) => [first, ...Array<string>(450).fill("-".repeat(99))].join("\n");
const logs: Record<string, string> = {
  "cat build.log": log("ERROR: disk quota exceeded on /var/build"),
  "cat test.log": log("PASS: 212 tests"),
};
const runAction = (input: string) => ({ name: "run_action", arguments: { input } });

const summarizing = (request: ScriptedRequestBody) => request.toolNames().length === 0;

async function agentWithLongLogs(reportedTokens?: number) {
  const agent = await testAgent(defaultSettings, { contextWindow });
  agent.tools.answerAll((_tool, args) => logs[String(args["input"])] ?? "");
  agent.provider
    .step("reads the build log", (request) => void request.call([runAction("cat build.log")]))
    .step("reads the test log", (request) => void request.call([runAction("cat test.log")]))
    .step("answers", (request) =>
      request.text(
        "The build failed.",
        reportedTokens === undefined ? {} : { inputTokens: reportedTokens },
      ),
    );
  const summaries = agent.provider.lane("summaries", summarizing);
  const first = await agent.open();
  await (await first.runtime.submit("check the build", { requestId: "m1" })).settled();
  return { agent, summaries, first };
}

describe("compaction", () => {
  it("compacts a context that outgrew the model's window and works on from the summary", async () => {
    const { agent, summaries, first } = await agentWithLongLogs(90_000);
    summaries.step("summary", (request) => {
      expect(request.body.model, "the conversation's own model writes the summary").toBe(
        defaultSettings.model.modelId,
      );
      expect(request.userTexts().join(), "the summary covers the oldest records").toContain(
        "check the build",
      );
      request.text("SUMMARY: the build failed; both logs were read.");
    });
    agent.provider.step("works from the summary", (request) => {
      expect(request.userTexts(), "the model sees the summary, then the new input").toEqual([
        expect.stringContaining("SUMMARY: the build failed"),
        "what exactly failed?",
      ]);
      expect(
        JSON.stringify(request.body.input),
        "the compacted build log is out of the context",
      ).not.toContain("disk quota");
      request.text("The disk quota on /var/build was exceeded.");
    });

    const input = await first.runtime.submit("what exactly failed?", { requestId: "m2" });

    expect(await input.settled()).toBe("done");
    agent.provider.assertComplete();
  });

  it("compacts and retries once when the provider rejects a request as too long", async () => {
    const { agent, summaries, first } = await agentWithLongLogs();
    agent.provider.step("too long", (request) =>
      request.status(400, "Your input exceeds the context window of this model."),
    );
    summaries.step("summary", (request) => request.text("SUMMARY: the build failed."));
    agent.provider.step("retried from the summary", (request) => {
      expect(request.userTexts()).toEqual([
        expect.stringContaining("SUMMARY: the build failed."),
        "what exactly failed?",
      ]);
      request.text("The disk quota was exceeded.");
    });

    const input = await first.runtime.submit("what exactly failed?", { requestId: "m2" });

    expect(await input.settled()).toBe("done");
    expect(
      agent.provider.requests.map(({ step }) => step),
      "one rejected request, one summary, and exactly one retry",
    ).toEqual([
      "reads the build log",
      "reads the test log",
      "answers",
      "too long",
      "summary",
      "retried from the summary",
    ]);
    agent.provider.assertComplete();
  });

  const failures: [string, (request: ScriptedRequest) => void][] = [
    ["fails", (request) => request.status(400, "summary refused")],
    [
      "is cut off at its token limit",
      (request) => request.text("SUMMARY: the bui", { truncated: true }),
    ],
  ];
  it.each(failures)(
    "keeps the context as it was when the summary request %s",
    async (_how, answer) => {
      const { agent, summaries, first } = await agentWithLongLogs(90_000);
      summaries.step("summary", answer);
      agent.provider.step("works on without a summary", (request) => {
        const answered = agent.provider.requests.find(({ step }) => step === "answers");
        expect(
          request.body.input.slice(0, answered?.body.input.length),
          "the context is sent on as it was",
        ).toEqual(answered?.body.input);
        expect(request.userTexts()).toEqual(["check the build", "what exactly failed?"]);
        expect(JSON.stringify(request.body.input), "no part of the summary is used").not.toContain(
          "SUMMARY",
        );
        request.text("The disk quota was exceeded.");
      });

      const input = await first.runtime.submit("what exactly failed?", { requestId: "m2" });

      expect(await input.settled()).toBe("done");
      agent.provider.assertComplete();
    },
  );
});

describe("closing during compaction", () => {
  it("aborts a summary request in flight, and the reopened runtime asks for the same summary again", async () => {
    const { agent, summaries, first } = await agentWithLongLogs(90_000);
    const cancelled = Promise.withResolvers<void>();
    summaries.step(
      "at close",
      (request) => void request.partialText("SUMMARY-A: the bu").then(cancelled.resolve),
    );
    await first.runtime.submit("what exactly failed?", { requestId: "m2" });
    await within(2000, "the summary request", summaries.received(1));

    await within(2000, "close", first.runtime.close());
    await within(2000, "the provider seeing the cancel", cancelled.promise);

    summaries.step("resumed", (request) => request.text("SUMMARY-B: the build failed."));
    agent.provider.step("works from the new summary", (request) => {
      expect(request.userTexts()).toEqual([
        expect.stringContaining("SUMMARY-B"),
        "what exactly failed?",
      ]);
      expect(
        JSON.stringify(request.body.input),
        "nothing of the aborted summary reached the context",
      ).not.toContain("SUMMARY-A");
      request.text("The disk quota was exceeded.");
    });
    const second = await agent.open();
    await second.runtime.idle();

    const [aborted, resumed] = summaries.requests;
    expect(resumed?.body.input, "the same summary is asked for again").toEqual(aborted?.body.input);
    agent.provider.assertComplete();
  });
});
