import { describe, expect, it } from "vitest";
import type { ChatPort } from "../src/index.ts";
import { testChat } from "./test-chat.ts";
import { testAgent } from "./support.ts";

const send = (conversation: number, body: string) => ({
  name: "chat_send",
  arguments: { timeline: { conversation }, body },
});
const readUnread = (conversation: number) => ({
  name: "chat_read_unread",
  arguments: { timeline: { conversation } },
});

describe("chat tools", () => {
  it("tells the primary conversation that plain output goes nowhere and speaking takes chat_send", async () => {
    const agent = await testAgent();
    const { port } = testChat();
    agent.provider.step("answer", (request) => {
      const system = request.systemTexts().join("\n");
      expect(system, "plain output is not delivered").toMatch(/plain text output goes nowhere/i);
      expect(system, "the send tool is the way to speak").toContain("call chat_send");
      expect(system, "notices are hints").toMatch(/only hints/);
      request.text("ok");
    });
    const { runtime } = await agent.open({ chat: port });

    await (await runtime.submit("hello", { requestId: "m1" })).settled();

    agent.provider.assertComplete();
  });

  it("holds a send when someone wrote after the Agent's last read, shows the new entries, and lets the resend through", async () => {
    const agent = await testAgent();
    const { port, general, post, messages } = testChat();
    post("Please deploy.");
    let held: string[] = [];
    let resent: string[] = [];
    agent.provider
      .step("read", (request) => void request.call([readUnread(general)]))
      .step("send while the owner writes", (request) => {
        post("Wait, use staging.");
        held = request.call([send(general, "Deploying to prod.")]);
      })
      .step("resend", (request) => {
        const output = request.toolOutput(held[0] ?? "") ?? "";
        expect(output, "the send was held").toContain('"status":"held"');
        expect(output, "the held result carries what the Agent missed").toContain(
          "Wait, use staging.",
        );
        resent = request.call([send(general, "Deploying to staging.")]);
      })
      .step("done", (request) => {
        expect(request.toolOutput(resent[0] ?? ""), "the resend went out").toContain(
          '"status":"sent"',
        );
        request.text("done");
      });
    const { runtime } = await agent.open({ chat: port });

    await (await runtime.submit("deploy request", { requestId: "m1" })).settled();

    expect(messages(), "only the resend reached the channel").toEqual([
      "Please deploy.",
      "Wait, use staging.",
      "Deploying to staging.",
    ]);
    agent.provider.assertComplete();
  });

  it("reruns a send interrupted by a crash, and the channel holds the message once", async () => {
    const agent = await testAgent();
    const { port, general, messages } = testChat();
    let first: Awaited<ReturnType<typeof agent.open>> | undefined;
    const sent = Promise.withResolvers<void>();
    // The process dies after the chat app took the message and before the tool result was stored.
    const dying: ChatPort = {
      ...port,
      send: (timeline, request) => {
        const result = port.send(timeline, request);
        first?.database().freeze();
        sent.resolve();
        return result;
      },
    };
    let rerun = 0;
    const counting: ChatPort = {
      ...port,
      send: (timeline, request) => {
        rerun += 1;
        return port.send(timeline, request);
      },
    };
    agent.provider.step("send", (request) => void request.call([send(general, "Deployed.")]));
    first = await agent.open({ chat: dying });
    await first.runtime.submit("tell them", { requestId: "m1" });
    await sent.promise;

    agent.provider.step("after restart", (request) => {
      expect(request.toolOutputs().join(), "the rerun returns the stored receipt").toContain(
        '"status":"sent"',
      );
      request.text("told them");
    });
    const second = await agent.open({ chat: counting });
    await second.runtime.idle();

    expect(rerun, "the interrupted send ran again after the restart").toBe(1);
    expect(messages(), "the channel holds the message once").toEqual(["Deployed."]);
    agent.provider.assertComplete();
  });

  it("gives the model the very page it first read when a read is interrupted by a crash", async () => {
    const agent = await testAgent();
    const { port, general, post } = testChat();
    post("First news.");
    let first: Awaited<ReturnType<typeof agent.open>> | undefined;
    const read = Promise.withResolvers<void>();
    const dying: ChatPort = {
      ...port,
      readUnread: (timeline, request) => {
        const result = port.readUnread(timeline, request);
        first?.database().freeze();
        read.resolve();
        return result;
      },
    };
    agent.provider.step("read", (request) => void request.call([readUnread(general)]));
    first = await agent.open({ chat: dying });
    await first.runtime.submit("catch up", { requestId: "m1" });
    await read.promise;
    post("Later news.");

    agent.provider.step("after restart", (request) => {
      const output = request.toolOutputs().join();
      expect(output, "the page read before the crash").toContain("First news.");
      expect(output, "not a fresh read from the advanced position").not.toContain("Later news.");
      request.text("caught up");
    });
    const second = await agent.open({ chat: port });
    await second.runtime.idle();

    agent.provider.assertComplete();
  });

  it("executes two independent tool calls even when the provider gave them the same call ID", async () => {
    const agent = await testAgent();
    const { port, general, messages } = testChat();
    // Steps with the same name answer with the same provider call ID.
    agent.provider
      .step("send", (request) => void request.call([send(general, "One.")]))
      .step("ack", (request) => request.text("sent one"))
      .step("send", (request) => void request.call([send(general, "Two.")]))
      .step("ack", (request) => request.text("sent two"));
    const { runtime } = await agent.open({ chat: port });

    await (await runtime.submit("say one", { requestId: "m1" })).settled();
    await (await runtime.submit("say two", { requestId: "m2" })).settled();

    expect(messages(), "each call reached the chat app").toEqual(["One.", "Two."]);
    agent.provider.assertComplete();
  });

  it("returns a chat refusal to the model as an error result with its reason", async () => {
    const agent = await testAgent();
    const { port } = testChat();
    let calls: string[] = [];
    agent.provider
      .step("send to nowhere", (request) => {
        calls = request.call([send(9999, "Hello?")]);
      })
      .step("read the refusal", (request) => {
        expect(request.toolOutput(calls[0] ?? "")).toContain("Refused (not-found)");
        request.text("that conversation does not exist");
      });
    const { runtime } = await agent.open({ chat: port });

    expect(await (await runtime.submit("post", { requestId: "m1" })).settled()).toBe("done");

    agent.provider.assertComplete();
  });

  it("refuses a chat tool an assistant calls anyway, and the chat app receives nothing", async () => {
    const agent = await testAgent();
    const { port, general, messages } = testChat();
    const finished = Promise.withResolvers<void>();
    agent.provider
      .step(
        "primary spawns",
        (request) =>
          void request.call([
            { name: "assistant", arguments: { action: "spawn", name: "poster", message: "post" } },
          ]),
      )
      .step("primary acknowledges", (request) => request.text("ok"))
      .step("primary reads the report", (request) => {
        request.text("noted");
        finished.resolve();
      });
    let forced: string[] = [];
    agent.provider
      .lane("poster", (request) => request.userTexts()[0] === "post")
      .step("assistant forces a chat tool", (request) => {
        forced = request.call([send(general, "Hi from the assistant.")]);
      })
      .step("assistant reads the failure", (request) => {
        expect(request.toolOutput(forced[0] ?? "")).toMatch(/not available/);
        request.text("I cannot post");
      });
    const { runtime } = await agent.open({ chat: port });

    await runtime.submit("have someone post", { requestId: "m1" });
    await finished.promise;
    await runtime.idle();

    expect(messages(), "nothing reached the channel").toEqual([]);
    agent.provider.assertComplete();
  });
});
