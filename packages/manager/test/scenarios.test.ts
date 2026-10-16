import { describe, expect, it } from "vitest";
import { environment, notices } from "./support.ts";

const readUnread = (conversation: number) => ({
  name: "chat_read_unread",
  arguments: { timeline: { conversation } },
});
const send = (conversation: number, body: string) => ({
  name: "chat_send",
  arguments: { timeline: { conversation }, body },
});

describe("the owner and an Agent in #general", () => {
  it("notifies the Agent once of a message that mentions it, and its reply reaches #general from its account", async () => {
    const env = await environment();
    const manager = await env.open();
    const { agentId, account } = await env.hire(manager);
    let read: string[] = [];
    let sent: string[] = [];
    env.provider
      .step("notice", (request) => {
        const [notice, ...more] = notices(request.userTexts());
        expect(more, "one notice").toEqual([]);
        expect(notice, "it says the Agent was mentioned").toContain("@了你");
        expect(notice, "it names #general as the read tool takes it").toContain(
          `#general {"conversation":${env.general}}`,
        );
        read = request.call([readUnread(env.general)]);
      })
      .step("reply", (request) => {
        expect(request.toolOutput(read[0] ?? ""), "the read returns the message").toContain(
          "Can you check the build?",
        );
        sent = request.call([send(env.general, "The build is green.")]);
      })
      .step("done", (request) => {
        expect(request.toolOutput(sent[0] ?? ""), "the send went out").toContain('"status":"sent"');
        expect(notices(request.userTexts()), "still only the one notice").toHaveLength(1);
        request.text("replied");
      });

    env.post("@richard Can you check the build?", { mentions: [account] });
    await env.provider.received(3);
    await manager.runtime(agentId)?.idle();

    expect(env.messages()).toEqual([
      { author: env.owner, body: "@richard Can you check the build?" },
      { author: account, body: "The build is green." },
    ]);
    env.provider.assertComplete();
  });

  it("holds the Agent's send when the owner wrote after its read, and lets the resend through", async () => {
    const env = await environment();
    const manager = await env.open();
    const { agentId, account } = await env.hire(manager);
    let held: string[] = [];
    let resent: string[] = [];
    env.provider
      .step("notice", (request) => void request.call([readUnread(env.general)]))
      .step("send while the owner writes", (request) => {
        // The owner's message lands after the Agent's read and before its send is checked.
        env.chat.beforeNextSendBy(account, () => env.post("Wait, use staging."));
        held = request.call([send(env.general, "Deploying to prod.")]);
      })
      .step("resend", (request) => {
        const output = request.toolOutput(held[0] ?? "") ?? "";
        expect(output, "the send was held").toContain('"status":"held"');
        expect(output, "with what the Agent missed").toContain("Wait, use staging.");
        resent = request.call([send(env.general, "Deploying to staging.")]);
      })
      .step("done", (request) => {
        expect(request.toolOutput(resent[0] ?? ""), "the resend went out").toContain(
          '"status":"sent"',
        );
        request.text("done");
      });

    env.post("Please deploy, @richard.", { mentions: [account] });
    await env.provider.received(4);
    await manager.runtime(agentId)?.idle();

    expect(env.messages(), "only the resend reached the channel").toEqual([
      { author: env.owner, body: "Please deploy, @richard." },
      { author: env.owner, body: "Wait, use staging." },
      { author: account, body: "Deploying to staging." },
    ]);
    env.provider.assertComplete();
  });
});
