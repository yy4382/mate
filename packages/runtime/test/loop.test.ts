import { bashTool } from "@palace/node-protocol";
import { ScriptedProvider } from "@palace/testkit";
import { describe, expect, it, onTestFinished } from "vitest";
import { defaultSettings, said, saidNow, testAgent, text } from "./support.ts";

describe("agent loop", () => {
  it("answers an input through the model", async () => {
    const agent = await testAgent();
    agent.provider.step("answer", (request) => {
      expect(request.userTexts()).toContain("hello there");
      request.text("hi owner");
    });
    const { runtime } = await agent.open();

    const input = await runtime.submit(said.input("m1", "hello there"));

    expect(await input.settled()).toBe("done");
    expect(agent.workspace.calls).toEqual([]);
    agent.provider.assertComplete();
  });

  it("admits the same requestId once however often it is submitted", async () => {
    const agent = await testAgent();
    agent.provider.step("answer", (request) => request.text("once"));
    const { runtime } = await agent.open();

    const first = await runtime.submit(said.input("same", "ping"));
    const second = await runtime.submit(said.input("same", "ping"));
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

    await (await runtime.submit(said.input("m1", "what is here?"))).settled();

    expect(agent.workspace.calls).toEqual([
      {
        tool: "bash",
        arguments: expect.objectContaining({ command: "ls" }),
        conversationId: expect.any(Number),
      },
    ]);
    agent.provider.assertComplete();
  });

  it("offers the node's bash definition with an optional execution target", async () => {
    const agent = await testAgent();
    let offered: Record<string, unknown> | undefined;
    agent.provider.step("look", (request) => {
      offered = request.body.tools?.find((tool) => tool.name === "bash");
      request.text("ok");
    });
    const { runtime } = await agent.open();
    await (await runtime.submit(said.input("m1", "hi"))).settled();

    expect(offered?.["description"], "what bash promises is what the node does").toBe(
      bashTool.description,
    );
    expect(offered?.["parameters"], "the node still receives its original arguments").toEqual({
      ...bashTool.parameters,
      properties: {
        ...bashTool.parameters.properties,
        node: expect.objectContaining({ type: "string" }),
      },
    });
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

    const input = await runtime.submit(said.input("m1", "build it"));
    const call = await agent.workspace.nextCall();
    await runtime.submit(saidNow.input("m2", "also run the tests"));
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

    await runtime.submit(said.input("m1", "build it"));
    const call = await agent.workspace.nextCall();
    const stale = saidNow.input("m2", "stale notice");
    await runtime.submit(stale);
    expect(await runtime.withdraw(stale.requestId)).toBe("withdrawn");
    call.resolve(text("built"));
    await runtime.idle();

    expect(await runtime.withdraw(stale.requestId)).toBe("settled");
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

    await runtime.submit(said.input("m1", "build it"));
    const call = await agent.workspace.nextCall();
    const note = saidNow.input("m2", "note");
    const steered = await runtime.submit(note);
    call.resolve(text("built"));
    await agent.provider.received(2);

    expect(await runtime.withdraw(note.requestId)).not.toBe("withdrawn");
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
      (await a.runtime.submit(said.input("m1", "alice: secret one"))).settled(),
      (await b.runtime.submit(said.input("m1", "bob: secret two"))).settled(),
    ]);
    await Promise.all([
      (await a.runtime.submit(said.input("m2", "alice: more"))).settled(),
      (await b.runtime.submit(said.input("m2", "bob: more"))).settled(),
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
