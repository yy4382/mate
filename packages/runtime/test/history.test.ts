import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testAgent, text } from "./support.ts";

const DURABLE_TOOL_RESULT_LIMIT = 50 * 1024;
const Page = z.object({
  total: z.number(),
  records: z.array(z.object({ n: z.number(), text: z.string() })),
});

describe("history tools", () => {
  it("returns a page that fits Durable's tool result limit as valid JSON, however many short records the Agent has", async () => {
    const rounds = 400;
    const agent = await testAgent();
    agent.workspace.answerAll(() => text("ok"));
    for (let round = 1; round <= rounds; round++)
      agent.provider.step(`round ${round}`, (request) => {
        request.call([{ name: "bash", arguments: { command: `echo ${round}` } }]);
      });
    let reads: string[] = [];
    let next: string[] = [];
    let first: { n: number }[] = [];
    let firstPageBytes = 0;
    agent.provider
      .step("reads the history", (request) => {
        reads = request.call([{ name: "history_read", arguments: { from: 1 } }]);
      })
      .step("reads on", (request) => {
        const output = request.toolOutput(reads[0] ?? "") ?? "";
        firstPageBytes = Buffer.byteLength(output, "utf8");
        const page = Page.parse(JSON.parse(output));
        first = page.records;
        expect(
          page.records.map(({ n }) => n),
          "from the first record, in order",
        ).toEqual(page.records.map((_, index) => index + 1));
        const last = page.records.at(-1)?.n ?? 0;
        next = request.call([{ name: "history_read", arguments: { from: last + 1 } }]);
      })
      .step("answers", (request) => {
        const page = Page.parse(JSON.parse(request.toolOutput(next[0] ?? "") ?? ""));
        expect(page.records[0]?.n, "the next page continues after the first").toBe(
          (first.at(-1)?.n ?? 0) + 1,
        );
        request.text("read");
      });
    const { runtime } = await agent.open();

    const input = await runtime.submit("go", { requestId: "m1" });

    expect(await input.settled()).toBe("done");
    expect(firstPageBytes).toBeGreaterThan(0);
    expect(firstPageBytes, "the serialized page fits the limit").toBeLessThanOrEqual(
      DURABLE_TOOL_RESULT_LIMIT,
    );
    expect(first.length, "the page is not needlessly short").toBeGreaterThan(100);
    agent.provider.assertComplete();
  });

  it("cuts a record whose escaped text alone would exceed the limit, and still returns valid JSON within it", async () => {
    const agent = await testAgent();
    agent.workspace.answerAll(() => text('"'.repeat(30_000)));
    let read: string[] = [];
    let output = "";
    agent.provider
      .step("runs", (request) => void request.call([{ name: "bash", arguments: { command: "x" } }]))
      .step("reads", (request) => {
        read = request.call([{ name: "history_read", arguments: { from: 3 } }]);
      })
      .step("answers", (request) => {
        output = request.toolOutput(read[0] ?? "") ?? "";
        request.text("done");
      });
    const { runtime } = await agent.open();

    await (await runtime.submit("go", { requestId: "m1" })).settled();

    expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(DURABLE_TOOL_RESULT_LIMIT);
    const page = Page.parse(JSON.parse(output));
    expect(page.records[0]?.text).toMatch(/more characters not shown\]$/);
  });
});
