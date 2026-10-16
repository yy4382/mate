import { bashTool } from "@mate/node-protocol";
import { ScriptedProvider } from "@mate/testkit";
import { describe, expect, it, onTestFinished } from "vitest";
import { testChat } from "./test-chat.ts";
import { defaultSettings, testAgent, text } from "./support.ts";

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

  it("forwards a tool call to the workspace and returns its result to the model", async () => {
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

    expect(agent.workspace.calls).toEqual([{ tool: "bash", arguments: { command: "ls" } }]);
    agent.provider.assertComplete();
  });

  it("offers the model the node's own bash tool, as the node protocol defines it", async () => {
    const agent = await testAgent();
    let offered: Record<string, unknown> | undefined;
    agent.provider.step("look", (request) => {
      offered = request.body.tools?.find((tool) => tool.name === "bash");
      request.text("ok");
    });
    const { runtime } = await agent.open();
    await (await runtime.submit("hi", { requestId: "m1" })).settled();

    expect(offered?.["description"], "what bash promises is what the node does").toBe(
      bashTool.description,
    );
    expect(offered?.["parameters"], "the node validates calls with the same schema").toEqual(
      bashTool.parameters,
    );
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

  it("keeps two Agents' contexts apart: each sees only its own inputs and tool results", async () => {
    const provider = await ScriptedProvider.start();
    onTestFinished(() => provider.close());
    const alice = await testAgent(defaultSettings, { provider });
    const bob = await testAgent(defaultSettings, { provider });
    alice.workspace.answerAll(() => text("alice-output"));
    bob.workspace.answerAll(() => text("bob-output"));
    const asks = (who: string) => (request: { userTexts(): string[] }) =>
      request.userTexts()[0]?.startsWith(who) ?? false;
    const script = (lane: ReturnType<ScriptedProvider["lane"]>, who: string) =>
      lane
        .step(
          `${who} lists`,
          (request) => void request.call([{ name: "bash", arguments: { command: "ls" } }]),
        )
        .step(`${who} answers`, (request) => request.text(`${who} is done`))
        .step(`${who} answers again`, (request) => request.text(`${who} again`));
    script(provider.lane("alice", asks("alice")), "alice");
    script(provider.lane("bob", asks("bob")), "bob");
    const [a, b] = await Promise.all([alice.open(), bob.open()]);

    await Promise.all([
      (await a.runtime.submit("alice: secret one", { requestId: "m1" })).settled(),
      (await b.runtime.submit("bob: secret two", { requestId: "m1" })).settled(),
    ]);
    await Promise.all([
      (await a.runtime.submit("alice: more", { requestId: "m2" })).settled(),
      (await b.runtime.submit("bob: more", { requestId: "m2" })).settled(),
    ]);

    for (const who of ["alice", "bob"]) {
      const other = who === "alice" ? "bob" : "alice";
      const requests = provider.requests.filter((request) => request.lane === who);
      const last = requests.at(-1);
      expect(last?.userTexts(), `${who} sees her own inputs, in order`).toEqual([
        `${who}: secret ${who === "alice" ? "one" : "two"}`,
        `${who}: more`,
      ]);
      expect(last?.toolOutputs(), `${who} sees her own tool result`).toEqual([
        expect.stringContaining(`${who}-output`),
      ]);
      for (const request of requests)
        expect(
          JSON.stringify(request.body.input),
          `${who} never sees ${other}'s input, tool result or answer`,
        ).not.toContain(other);
    }
    provider.assertComplete();
  });
});
