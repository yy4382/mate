import { describe, expect, it } from "vitest";
import { testAgent, text } from "./support.ts";

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
    agent.provider.step("partial", (request) => request.partialCall("bash", '{"command":"rm -'));
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
  it("aborts an open model request, and the work resumes on reopen", async () => {
    const agent = await testAgent();
    let cancelled: Promise<void> | undefined;
    agent.provider.step("slow", (request) => {
      cancelled = request.hang();
    });
    const first = await agent.open();
    const input = await first.runtime.submit("think hard", { requestId: "m1" });
    await agent.provider.received(1);

    await first.runtime.close();
    await cancelled;

    agent.provider.step("resumed", (request) => {
      expect(request.userTexts()).toEqual(["think hard"]);
      request.text("thought");
    });
    const second = await agent.open();
    await second.runtime.idle();
    expect(agent.provider.requests).toHaveLength(2);
    agent.provider.assertComplete();
    void input;
  });

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
    first.database().failNextTransactions(1);

    await expect(first.runtime.submit("hello", { requestId: "m1" })).rejects.toThrow();
    await expect(fatal.promise).resolves.toBeInstanceOf(Error);

    agent.provider.step("answer", (request) => request.text("hi"));
    const second = await agent.open();
    await (await second.runtime.submit("hello", { requestId: "m1" })).settled();
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
});
