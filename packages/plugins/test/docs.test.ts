import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { docsExtension } from "../src/docs.ts";
import { subagentExtension } from "../src/subagent.ts";
import { testAgent } from "./support.ts";

const shipped = fileURLToPath(new URL("./docs", import.meta.url));
const topics = readdirSync(shipped)
  .filter((file) => file.endsWith(".md"))
  .map((file) => file.slice(0, -".md".length));
const palaceDocs = (topic: string) => ({ name: "palace_docs", arguments: { topic } });

describe("Palace docs extension", () => {
  it("offers every shipped topic in primary and subagent conversations when positively allowlisted", async () => {
    const docs = docsExtension([shipped]);
    const subagent = subagentExtension({ extensions: [docs] });
    const agent = await testAgent();
    const offered: { primary: unknown[]; subagent: unknown[] } = { primary: [], subagent: [] };
    const tool = (request: { body: { tools?: { name?: string | undefined }[] | undefined } }) =>
      request.body.tools?.find(({ name }) => name === "palace_docs");

    agent.provider
      .step("primary delegates", (request) => {
        offered.primary.push(tool(request));
        request.call([{ name: "subagent", arguments: { prompt: "look at docs" } }]);
      })
      .step("primary answers", (request) => {
        offered.primary.push(tool(request));
        request.text("noted");
      });
    agent.provider
      .lane("worker", (request) => request.userTexts()[0] === "look at docs")
      .step("worker reads", (request) => {
        offered.subagent.push(tool(request));
        request.text("done");
      });

    const { runtime } = await agent.open({ extensions: [docs, subagent] });
    await (await runtime.submit("delegate", { requestId: "m1" })).settled();

    for (const [conversation, tools] of Object.entries(offered)) {
      expect(tools.length, `${conversation} made requests`).toBeGreaterThan(0);
      for (const found of tools) {
        const { description, parameters } = found as {
          description: string;
          parameters: { properties: { topic: { enum: string[] } } };
        };
        expect(parameters.properties.topic.enum).toEqual(expect.arrayContaining(topics));
        for (const topic of topics) expect(description).toContain(topic);
      }
    }
    agent.provider.assertComplete();
  });

  it("does not add docs to the system prompt and returns files verbatim", async () => {
    const docs = docsExtension([shipped]);
    const agent = await testAgent();
    let calls: string[] = [];
    let outputs: (string | undefined)[] = [];
    agent.provider
      .step("reads", (request) => {
        for (const topic of topics) {
          expect(request.systemTexts().join("\n")).not.toContain(
            readFileSync(join(shipped, `${topic}.md`), "utf8").slice(0, 200),
          );
        }
        calls = request.call(topics.map(palaceDocs));
      })
      .step("answers", (request) => {
        outputs = calls.map((id) => request.toolOutput(id));
        request.text("read them");
      });

    const { runtime } = await agent.open({ extensions: [docs] });
    await (await runtime.submit("read all", { requestId: "m1" })).settled();
    expect(outputs).toEqual(topics.map((t) => readFileSync(join(shipped, `${t}.md`), "utf8")));
    agent.provider.assertComplete();
  });

  it("reruns safely after crash and hides palace_docs when no topics exist", async () => {
    const docs = docsExtension([shipped]);
    const agent = await testAgent();
    const first = await agent.open({ extensions: [docs] });
    const started = Promise.withResolvers<void>();
    await first.runtime.watchEvents((events) => {
      if (!events.some((event) => event.type === "tool_execution_start")) return;
      first.database().freeze();
      started.resolve();
    });
    agent.provider.step("reads", (request) => void request.call([palaceDocs(topics[0] ?? "")]));
    await first.runtime.submit("go", { requestId: "m1" });
    await started.promise;

    let output = "";
    agent.provider.step("after restart", (request) => {
      output = request.toolOutputs().join();
      request.text("read it");
    });
    const second = await agent.open({ extensions: [docs] });
    await second.runtime.idle();
    expect(output).toBe(readFileSync(join(shipped, `${topics[0]}.md`), "utf8"));

    const empty = await testAgent();
    empty.provider.step("no tool", (request) => {
      expect(request.toolNames()).not.toContain("palace_docs");
      request.text("ok");
    });
    const openedEmpty = await empty.open({ extensions: [docsExtension([])] });
    await (await openedEmpty.runtime.submit("hi", { requestId: "m1" })).settled();
  });

  it("refuses duplicate topics across directories", () => {
    const more = fileURLToPath(new URL("./more-docs", import.meta.url));
    expect(() => docsExtension([shipped, more])).toThrow(/lighthouse/);
  });
});
