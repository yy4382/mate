import { ChatApp } from "@mate/chat";
import { temporaryDirectory } from "@mate/testkit";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import type { ChatPort } from "../src/index.ts";

/** A real chat app with the owner, the Agent's account, and #general with both in it. Closed after the test. */
export function testChat() {
  const chat = new ChatApp(join(temporaryDirectory(), "chat.sqlite"));
  onTestFinished(() => chat.close());
  const owner = chat.ensureAccount({
    externalId: "owner",
    displayName: "Owner",
    handle: "owner",
    kind: "human",
  });
  const self = chat.ensureAccount({
    externalId: "agent-1",
    displayName: "Richard",
    handle: "richard",
    kind: "agent",
  });
  const general = chat.createChannel(owner, {
    requestId: "setup:general",
    name: "general",
    visibility: "public",
  }).conversationId;
  chat.join(self, { requestId: "setup:join", conversationId: general });
  return {
    chat,
    owner,
    general,
    port: chat.forAccount(self) satisfies ChatPort,
    /** The owner posts to #general, without the freshness check, as the web client does. */
    post: (body: string) =>
      chat.send(
        owner,
        { conversation: general },
        { requestId: `owner:${body}`, body, freshness: false },
      ),
    /** The bodies of the messages in #general, oldest first. */
    messages: () =>
      chat
        .readHistory(owner, { conversation: general })
        .flatMap((entry) => (entry.kind === "message" ? [entry.body] : []))
        .reverse(),
  };
}
