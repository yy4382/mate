import { openChatApp, type ChatApp } from "@mate/chat";
import { temporaryDirectory } from "@mate/testkit";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import type { ChatPort } from "../src/index.ts";

/** What the Agent Manager does: the real chat app, bound to one Agent's account. Nothing but currying. */
export function chatPort(chat: ChatApp, account: number): ChatPort {
  return {
    readUnread: (timeline, request) => chat.readUnread(account, timeline, request),
    readHistory: (timeline, query) => chat.readHistory(account, timeline, query),
    search: (query) => chat.search(account, query),
    send: (timeline, request) => chat.send(account, timeline, request),
    join: (request) => chat.join(account, request),
    leave: (request) => chat.leave(account, request),
    openDm: (request) => chat.openDm(account, request),
    listConversations: () => chat.listConversations(account),
    createTask: (request) => chat.createTask(account, request),
    changeTask: (request) => chat.changeTask(account, request),
  };
}

/** A real chat app with the owner, the Agent's account, and #general with both in it. Closed after the test. */
export function testChat() {
  const chat = openChatApp(join(temporaryDirectory(), "chat.sqlite"));
  onTestFinished(() => chat.close());
  const owner = chat.ensureAccount({
    externalId: "owner",
    displayName: "Owner",
    handle: "owner",
    role: "owner",
  });
  const self = chat.ensureAccount({
    externalId: "agent-1",
    displayName: "Richard",
    handle: "richard",
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
    port: chatPort(chat, self),
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
