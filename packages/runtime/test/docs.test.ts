import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { testAgent } from "./support.ts";

const shipped = dirname(fileURLToPath(import.meta.resolve("@palace/runtime/docs/webhooks.md")));
const topics = readdirSync(shipped)
  .filter((file) => file.endsWith(".md"))
  .map((file) => file.slice(0, -".md".length));
const palaceDocs = (topic: string) => ({ name: "palace_docs", arguments: { topic } });

describe("Palace docs", () => {
  it("ships at least one topic", () => {
    expect(topics.length).toBeGreaterThan(0);
  });

  it("offers every shipped topic on every request, in the primary conversation and in an assistant", async () => {
    const agent = await testAgent();
    const finished = Promise.withResolvers<void>();
    const offered: { primary: unknown[]; assistant: unknown[] } = { primary: [], assistant: [] };
    const tool = (request: { body: { tools?: { name?: string | undefined }[] | undefined } }) =>
      request.body.tools?.find(({ name }) => name === "palace_docs");
    agent.provider
      .step("primary spawns", (request) => {
        offered.primary.push(tool(request));
        request.call([
          { name: "assistant", arguments: { action: "spawn", name: "helper", message: "look" } },
        ]);
      })
      .step("primary acknowledges", (request) => {
        offered.primary.push(tool(request));
        request.text("ok");
      })
      .step("primary reads the report", (request) => {
        offered.primary.push(tool(request));
        request.text("noted");
        finished.resolve();
      });
    agent.provider
      .lane("helper", (request) => request.userTexts()[0] === "look")
      .step("assistant works", (request) => {
        offered.assistant.push(tool(request));
        request.text("done");
      });
    const { runtime } = await agent.open();

    await runtime.submit("delegate it", { requestId: "m1" });
    await finished.promise;
    await runtime.idle();

    for (const [conversation, tools] of Object.entries(offered)) {
      expect(tools.length, `${conversation} made requests`).toBeGreaterThan(0);
      for (const found of tools) {
        const { description, parameters } = found as {
          description: string;
          parameters: { properties: { topic: { enum: string[] } } };
        };
        expect(parameters.properties.topic.enum, `${conversation} can ask for each topic`).toEqual(
          expect.arrayContaining(topics),
        );
        for (const topic of topics)
          expect(description, `${conversation} is told about ${topic}`).toContain(topic);
      }
    }
    agent.provider.assertComplete();
  });

  it("does not add the docs to the system prompt", async () => {
    const agent = await testAgent();
    agent.provider.step("answers", (request) => {
      for (const topic of topics)
        expect(request.systemTexts().join("\n"), topic).not.toContain(
          readFileSync(join(shipped, `${topic}.md`), "utf8").slice(0, 200),
        );
      request.text("hi");
    });
    const { runtime } = await agent.open();

    await (await runtime.submit("hello", { requestId: "m1" })).settled();

    agent.provider.assertComplete();
  });

  it("returns each shipped file unchanged", async () => {
    const agent = await testAgent();
    let calls: string[] = [];
    let outputs: (string | undefined)[] = [];
    agent.provider
      .step("reads every topic", (request) => {
        calls = request.call(topics.map(palaceDocs));
      })
      .step("answers", (request) => {
        outputs = calls.map((id) => request.toolOutput(id));
        request.text("read them");
      });
    const { runtime } = await agent.open();

    await (await runtime.submit("how does it work?", { requestId: "m1" })).settled();

    expect(outputs).toEqual(
      topics.map((topic) => readFileSync(join(shipped, `${topic}.md`), "utf8")),
    );
    agent.provider.assertComplete();
  });

  it("refuses an unknown topic as a tool error, and the run continues", async () => {
    const agent = await testAgent();
    let call: string[] = [];
    let output = "";
    agent.provider
      .step("asks for a topic that does not exist", (request) => {
        call = request.call([palaceDocs("no-such-topic")]);
      })
      .step("answers", (request) => {
        output = request.toolOutput(call[0] ?? "") ?? "";
        request.text("sorry");
      });
    const { runtime } = await agent.open();

    expect(await (await runtime.submit("explain", { requestId: "m1" })).settled()).toBe("done");

    expect(output, "the model got a refusal, not a doc").not.toBe("");
    for (const topic of topics)
      expect(output).not.toBe(readFileSync(join(shipped, `${topic}.md`), "utf8"));
    agent.provider.assertComplete();
  });

  it("reruns a call interrupted by a crash after reopening", async () => {
    const agent = await testAgent();
    const first = await agent.open();
    const started = Promise.withResolvers<void>();
    await first.runtime.watchEvents((events) => {
      if (!events.some((event) => event.type === "tool_execution_start")) return;
      first.database().freeze();
      started.resolve();
    });
    agent.provider.step("reads", (request) => void request.call([palaceDocs(topics[0] ?? "")]));
    await first.runtime.submit("how does it work?", { requestId: "m1" });
    await started.promise;

    let output = "";
    agent.provider.step("after restart", (request) => {
      output = request.toolOutputs().join();
      request.text("read it");
    });
    const second = await agent.open();
    await second.runtime.idle();

    expect(output, "the call completed instead of being reported as interrupted").toBe(
      readFileSync(join(shipped, `${topics[0]}.md`), "utf8"),
    );
    agent.provider.assertComplete();
  });
});
