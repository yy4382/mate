import type { ScriptedRequest } from "@mate/testkit";
import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "../src/index.ts";
import { testAgent, text, within } from "./support.ts";

describe("crash and reopen", () => {
  it("does not rerun a command interrupted by a crash, and tells the model it was interrupted", async () => {
    const agent = await testAgent();
    agent.provider.step(
      "start",
      (request) => void request.call([{ name: "bash", arguments: { command: "deploy" } }]),
    );
    const first = await agent.open();
    await first.runtime.submit("deploy it", { requestId: "m1" });
    const call = await agent.workspace.nextCall();

    first.database().freeze();
    call.resolve(text("deployed"));

    agent.provider.step("after restart", (request) => {
      expect(request.toolOutputs().join()).toMatch(/interrupt/i);
      request.text("I will check whether the deploy happened");
    });
    const second = await agent.open();
    await second.runtime.idle();

    expect(agent.workspace.calls).toHaveLength(1);
    agent.provider.assertComplete();
  });

  it("reruns an interrupted read after a crash with the same requestId", async () => {
    const agent = await testAgent();
    agent.provider.step(
      "start",
      (request) => void request.call([{ name: "read", arguments: { path: "MEMORY.md" } }]),
    );
    const first = await agent.open();
    await first.runtime.submit("recall", { requestId: "m1" });
    const call = await agent.workspace.nextCall();
    first.database().freeze();

    agent.workspace.answerAll(() => text("notes"));
    agent.provider.step("after restart", (request) => {
      expect(request.toolOutputs().join()).toContain("notes");
      request.text("recalled");
    });
    const second = await agent.open();
    await second.runtime.idle();

    expect(agent.workspace.calls.map((request) => request.requestId)).toEqual([
      call.request.requestId,
      call.request.requestId,
    ]);
    agent.provider.assertComplete();
  });

  it("never executes a tool call whose arguments were still streaming when the process died", async () => {
    const agent = await testAgent();
    agent.provider.step(
      "partial",
      (request) => void request.partialCall("bash", '{"command":"rm -'),
    );
    const first = await agent.open();
    await first.runtime.submit("clean up", { requestId: "m1" });
    await agent.provider.received(1);
    first.database().freeze();
    await first.runtime.close().catch(() => undefined);

    agent.provider.step("after restart", (request) => request.text("starting over"));
    const second = await agent.open();
    await second.runtime.idle();

    expect(agent.workspace.calls).toEqual([]);
    agent.provider.assertComplete();
  });

  it("keeps the request prefix unchanged across a reopen", async () => {
    const agent = await testAgent();
    agent.provider.step("one", (request) => request.text("first answer"));
    const first = await agent.open();
    await (await first.runtime.submit("first", { requestId: "m1" })).settled();
    await first.runtime.close();

    agent.provider.step("two", (request) => request.text("second answer"));
    const second = await agent.open();
    await (await second.runtime.submit("second", { requestId: "m2" })).settled();

    const [before, after] = agent.provider.requests;
    expect(after?.body.input.slice(0, before?.body.input.length)).toEqual(before?.body.input);
    expect(after?.body.prompt_cache_key).toBe(before?.body.prompt_cache_key);
    agent.provider.assertComplete();
  });
});

describe("closing", () => {
  it("aborts a model request about to be sent, so the provider never sees it, and the work resumes on reopen", async () => {
    const agent = await testAgent();
    const closeCalled = Promise.withResolvers<void>();
    let closing: Promise<void> | undefined;
    let runtime: AgentRuntime | undefined;
    // The key is read as the request is prepared, so closing here is closing just before it is sent.
    const first = await agent.open({
      apiKey: () => {
        if (runtime !== undefined) {
          closing = runtime.close();
          closeCalled.resolve();
        }
        return "test-key";
      },
    });
    runtime = first.runtime;
    await first.runtime.submit("think hard", { requestId: "m1" });
    await within(2000, "the request being prepared", closeCalled.promise);
    await within(2000, "close", closing ?? Promise.resolve());

    expect(agent.provider.requests, "the closed runtime sent nothing").toEqual([]);
    agent.provider.step("resumed", (request) => {
      expect(request.userTexts()).toEqual(["think hard"]);
      request.text("thought");
    });
    const second = await agent.open();
    await second.runtime.idle();
    expect(agent.provider.requests, "only the reopened runtime's request arrived").toHaveLength(1);
    agent.provider.assertComplete();
  });

  const stages: [string, (request: ScriptedRequest) => Promise<void>][] = [
    ["waiting for the response headers", (request) => request.hang()],
    ["streaming the answer", (request) => request.partialText("Half of my ans")],
    ["streaming a tool call", (request) => request.partialCall("bash", '{"command":"rm -')],
  ];
  it.each(stages)(
    "aborts a model request %s, and nothing the closed runtime received reaches the reopened one",
    async (_stage, answer) => {
      const agent = await testAgent();
      const cancelled = Promise.withResolvers<void>();
      agent.provider.step("at close", (request) => void answer(request).then(cancelled.resolve));
      const first = await agent.open();
      await first.runtime.submit("think hard", { requestId: "m1" });
      await agent.provider.received(1);

      await within(2000, "close", first.runtime.close());
      await within(2000, "the provider seeing the cancel", cancelled.promise);

      agent.provider.step("resumed", (request) => request.text("thought"));
      const second = await agent.open();
      await second.runtime.idle();
      const [aborted, resumed] = agent.provider.requests;
      expect(
        resumed?.body.input,
        "the resumed request is the aborted one again: no part of the aborted answer was kept",
      ).toEqual(aborted?.body.input);
      expect(agent.workspace.calls, "the half-streamed tool call never ran").toEqual([]);
      agent.provider.assertComplete();
    },
  );

  it("aborts an in-flight workspace call", async () => {
    const agent = await testAgent();
    agent.provider.step(
      "start",
      (request) => void request.call([{ name: "bash", arguments: { command: "sleep 100" } }]),
    );
    const { runtime } = await agent.open();
    await runtime.submit("wait", { requestId: "m1" });
    const call = await agent.workspace.nextCall();

    await runtime.close();

    expect(call.signal.aborted).toBe(true);
  });

  it("closes itself instead of hanging when its storage fails, and reopens from what was stored", async () => {
    const agent = await testAgent();
    const fatal = Promise.withResolvers<unknown>();
    const first = await agent.open({ onFatal: fatal.resolve });
    first.database().failNextWrites(1);

    await expect(first.runtime.submit("hello", { requestId: "m1" })).rejects.toThrow();
    await expect(fatal.promise).resolves.toBeInstanceOf(Error);

    agent.provider.step("answer", (request) => request.text("hi"));
    const second = await agent.open();
    await (await second.runtime.submit("hello", { requestId: "m1" })).settled();
    agent.provider.assertComplete();
  });
});

describe("storage failure", () => {
  it("ends the work instead of hanging when a commit fails mid-run, and a reopened runtime answers new input", async () => {
    const agent = await testAgent();
    agent.provider.step(
      "start",
      (request) => void request.call([{ name: "bash", arguments: { command: "make" } }]),
    );
    const fatal = Promise.withResolvers<unknown>();
    const first = await agent.open({ onFatal: fatal.resolve });
    const input = await first.runtime.submit("build it", { requestId: "m1" });
    const call = await agent.workspace.nextCall();

    first.database().failNextWrites(1);
    call.resolve(text("built"));

    await expect(within(2000, "onFatal", fatal.promise)).resolves.toBeInstanceOf(Error);
    const outcome = (promise: Promise<unknown>) =>
      promise.then(
        () => "resolved",
        () => "rejected",
      );
    expect(
      await within(2000, "the input settling", outcome(input.settled())),
      "the work ends in failure, not in an answer",
    ).toBe("rejected");
    expect(await within(2000, "idle", outcome(first.runtime.idle()))).toBe("rejected");
    await within(2000, "close", first.runtime.close());

    agent.provider
      .step("resumed", (request) => {
        expect(request.userTexts()).toEqual(["build it"]);
        request.text("I will check the build");
      })
      .step("new input", (request) => {
        expect(request.userTexts()).toEqual(["build it", "and test it"]);
        request.text("tested");
      });
    const second = await agent.open();
    await second.runtime.idle();
    const next = await second.runtime.submit("and test it", { requestId: "m2" });
    expect(await within(2000, "the new input settling", next.settled())).toBe("done");
    agent.provider.assertComplete();
  });
});

describe("settings", () => {
  it("applies a model change from the next request", async () => {
    const agent = await testAgent();
    agent.provider
      .step("before", (request) => request.text("a"))
      .step("after", (request) => request.text("b"));
    const { runtime } = await agent.open();

    await (await runtime.submit("one", { requestId: "m1" })).settled();
    await runtime.configure({ model: { provider: "openai", modelId: "gpt-4.1-mini" } });
    await (await runtime.submit("two", { requestId: "m2" })).settled();

    expect(agent.provider.requests.map((request) => request.body.model)).toEqual([
      "gpt-4.1",
      "gpt-4.1-mini",
    ]);
    agent.provider.assertComplete();
  });

  it("counts the tokens every response reported", async () => {
    const agent = await testAgent();
    agent.provider.step("answer", (request) => request.text("hi", { inputTokens: 120 }));
    const { runtime } = await agent.open();

    await (await runtime.submit("hello", { requestId: "m1" })).settled();

    const usage = await runtime.usage();
    expect(usage.models["openai/gpt-4.1"]).toMatchObject({ input: 120, output: 10 });
  });

  it("applies a thinking level change from the next request, and leaves the request in flight as it was sent", async () => {
    const agent = await testAgent({
      model: { provider: "openai", modelId: "gpt-5-mini" },
      thinkingLevel: "low",
    });
    agent.workspace.answerAll(() => text("a.txt"));
    const configured = Promise.withResolvers<void>();
    agent.provider
      .step("in flight during the change", async (request) => {
        await configured.promise;
        request.call([{ name: "bash", arguments: { command: "ls" } }]);
      })
      .step("after the change", (request) => {
        expect(request.toolOutputs().join(), "the in-flight answer was used").toContain("a.txt");
        request.text("one file");
      });
    const { runtime } = await agent.open();
    const input = await runtime.submit("what is here?", { requestId: "m1" });
    await agent.provider.received(1);

    await runtime.configure({
      model: { provider: "openai", modelId: "gpt-5" },
      thinkingLevel: "high",
    });
    configured.resolve();

    expect(await input.settled()).toBe("done");
    expect(
      agent.provider.requests.map(({ body }) => [body.model, body.reasoning]),
      "the request sent before the change completed once, as sent; the next one carries the change",
    ).toEqual([
      ["gpt-5-mini", expect.objectContaining({ effort: "low" })],
      ["gpt-5", expect.objectContaining({ effort: "high" })],
    ]);
    agent.provider.assertComplete();
  });

  it("keeps answering however many tokens it has used", async () => {
    const agent = await testAgent();
    agent.provider
      .step("costly", (request) => request.text("a", { inputTokens: 1_000_000_000_000 }))
      .step("still answering", (request) => request.text("b"));
    const { runtime } = await agent.open();

    await (await runtime.submit("one", { requestId: "m1" })).settled();
    expect((await runtime.usage()).models["openai/gpt-4.1"]?.input).toBe(1_000_000_000_000);
    const next = await runtime.submit("two", { requestId: "m2" });

    expect(await next.settled(), "a trillion tokens later the Agent still answers").toBe("done");
    agent.provider.assertComplete();
  });
});
