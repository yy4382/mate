import { describe, expect, it } from "vitest";
import { testChat } from "./test-chat.ts";
import { testAgent, text } from "./support.ts";

describe("agent loop", () => {
  it("answers an input through the model and posts its final text nowhere", async () => {
    const agent = await testAgent();
    const chat = testChat();
    agent.provider.step("answer", (request) => {
      expect(request.userTexts()).toContain("hello there");
      request.text("hi owner");
    });
    const { runtime } = await agent.open({ chat: chat.port });

    const input = await runtime.submit("hello there", { requestId: "m1" });

    expect(await input.settled()).toBe("done");
    expect(
      chat.chat.search(chat.owner, "hi owner"),
      "the final text is in no conversation the owner can read, which is every one",
    ).toEqual([]);
    expect(chat.chat.unreadSummary(chat.owner).total, "and notified nobody").toBe(0);
    expect(agent.workspace.calls).toEqual([]);
    agent.provider.assertComplete();
  });

  it("admits the same requestId once however often it is submitted", async () => {
    const agent = await testAgent();
    agent.provider.step("answer", (request) => request.text("once"));
    const { runtime } = await agent.open();

    const first = await runtime.submit("ping", { requestId: "same" });
    const second = await runtime.submit("ping", { requestId: "same" });
    await Promise.all([first.settled(), second.settled()]);
    await runtime.idle();

    expect(agent.provider.requests).toHaveLength(1);
    agent.provider.assertComplete();
  });

  it("forwards a tool call to the workspace with a stable requestId and returns its result to the model", async () => {
    const agent = await testAgent();
    agent.workspace.answerAll(() => text("a.txt\nb.txt"));
    let callIds: string[] = [];
    agent.provider
      .step("list", (request) => {
        callIds = request.call([{ name: "bash", arguments: { command: "ls" } }]);
      })
      .step("answer", (request) => {
        expect(request.toolOutput(callIds[0] ?? "")).toContain("b.txt");
        request.text("two files");
      });
    const { runtime } = await agent.open();

    await (await runtime.submit("what is here?", { requestId: "m1" })).settled();

    expect(agent.workspace.calls).toEqual([
      {
        requestId: expect.stringMatching(/^tool:\d+$/),
        tool: "bash",
        arguments: { command: "ls" },
      },
    ]);
    agent.provider.assertComplete();
  });

  it("places an input steered while busy after the current tool round, in the same run", async () => {
    const agent = await testAgent();
    agent.provider
      .step(
        "start",
        (request) => void request.call([{ name: "bash", arguments: { command: "make" } }]),
      )
      .step("continue", (request) => {
        expect(request.userTexts()).toEqual(["build it", "also run the tests"]);
        expect(request.toolOutputs().join()).toContain("built");
        request.text("done");
      });
    const { runtime } = await agent.open();

    const input = await runtime.submit("build it", { requestId: "m1" });
    const call = await agent.workspace.nextCall();
    await runtime.submit("also run the tests", { requestId: "m2", whenBusy: "steer" });
    call.resolve(text("built"));

    expect(await input.settled()).toBe("done");
    await runtime.idle();
    expect(agent.provider.requests).toHaveLength(2);
    agent.provider.assertComplete();
  });

  it("never shows the model an input withdrawn before it was placed", async () => {
    const agent = await testAgent();
    agent.provider
      .step(
        "start",
        (request) => void request.call([{ name: "bash", arguments: { command: "make" } }]),
      )
      .step("finish", (request) => {
        expect(request.userTexts()).toEqual(["build it"]);
        request.text("done");
      });
    const { runtime } = await agent.open();

    await runtime.submit("build it", { requestId: "m1" });
    const call = await agent.workspace.nextCall();
    await runtime.submit("stale notice", { requestId: "m2", whenBusy: "steer" });
    expect(await runtime.withdraw("m2")).toBe("withdrawn");
    call.resolve(text("built"));
    await runtime.idle();

    expect(await runtime.withdraw("m2")).toBe("settled");
    expect(await runtime.withdraw("never-sent")).toBe("not_found");
    agent.provider.assertComplete();
  });

  it("reports an input the model has already seen as placed, not withdrawn", async () => {
    const agent = await testAgent();
    agent.provider
      .step(
        "start",
        (request) => void request.call([{ name: "bash", arguments: { command: "make" } }]),
      )
      .step("finish", (request) => request.text("done"));
    const { runtime } = await agent.open();

    await runtime.submit("build it", { requestId: "m1" });
    const call = await agent.workspace.nextCall();
    const steered = await runtime.submit("note", { requestId: "m2", whenBusy: "steer" });
    call.resolve(text("built"));
    await agent.provider.received(2);

    expect(await runtime.withdraw("m2")).not.toBe("withdrawn");
    expect(await steered.settled()).toBe("done");
    await runtime.idle();
    agent.provider.assertComplete();
  });
});
