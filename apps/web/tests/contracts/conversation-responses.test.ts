// @vitest-environment jsdom
// @vitest-environment jsdom
import { act, screen } from "@testing-library/react";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  messageSchema,
  readChatEvent,
} from "../../src/features/conversations/conversation-responses.js";

import {
  TestEventSource,
  publicChannel,
  message,
  openChat,
  resetFixture,
  cleanupFixture,
} from "../support/chat-fixture.js";
beforeEach(resetFixture);
afterEach(cleanupFixture);

it("keeps optional message metadata absent, including nested replies, and tolerates extra fields", () => {
  const wire = message(publicChannel.id, "minimal", "只有必需字段", "1");
  const parsed = messageSchema.parse({ ...wire, futureField: { preserved: true } });
  expect(parsed).toEqual({ ...wire, futureField: { preserved: true } });
  expect(parsed).not.toHaveProperty("quoteId");
  expect(parsed).not.toHaveProperty("replyCount");
  expect(parsed).not.toHaveProperty("recentReplies");
  const nested = messageSchema.parse({ ...wire, recentReplies: [{ ...wire, rootId: wire.id }] });
  expect(nested.recentReplies?.[0]).not.toHaveProperty("recentReplies");
  expect(messageSchema.safeParse({ ...wire, order: "not-an-integer" }).success).toBe(false);
});

it("ignores invalid stream payloads and still receives a subsequent valid message", async () => {
  await openChat();
  const stream = TestEventSource.instances[0]!;
  const incoming = message(publicChannel.id, "validated-live", "有效的实时消息", "1");
  const envelope = { channelId: publicChannel.id, kind: "message.created" };
  expect(readChatEvent(new Event("message.created"))).toBeNull();
  expect(readChatEvent(new MessageEvent("message.created", { data: "invalid JSON" }))).toBeNull();
  expect(readChatEvent(new MessageEvent("message.created", { data: {} }))).toBeNull();
  act(() => {
    stream.emit("message.created", { ...envelope, payload: { id: incoming.id } });
    stream.emit("message.created", { ...envelope, payload: { ...incoming, order: "bad" } });
    stream.emit("message.created", {
      ...envelope,
      kind: "channel.created",
      payload: publicChannel,
    });
  });
  expect(screen.queryByText(incoming.text)).toBeNull();
  act(() => stream.emit("message.created", { ...envelope, payload: incoming, futureField: true }));
  expect(await screen.findByText(incoming.text)).not.toBeNull();
});

vi.mock("../../src/features/conversations/chat.css", () => ({}));
vi.mock("../../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
