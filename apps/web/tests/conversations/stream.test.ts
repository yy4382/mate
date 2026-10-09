// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";

import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatPage } from "../../src/features/conversations/chat-page.js";
import { messageSchema } from "../../src/features/conversations/conversation-responses.js";
import { ownerJSON, OwnerRequestError } from "../../src/features/conversations/owner-request.js";
import { redirectToLogin } from "../../src/navigation.js";
import {
  fixture,
  TestEventSource,
  publicChannel,
  privateChannel,
  message,
  json,
  openChat,
  resetFixture,
  cleanupFixture,
} from "../support/chat-fixture.js";
beforeEach(resetFixture);
afterEach(cleanupFixture);

it("keeps an Agent DM event that arrives as the initial selected channel is being restored", async () => {
  window.history.replaceState({}, "", `/app?channel=${privateChannel.id}`);
  TestEventSource.messageOnConnect = {
    channelId: privateChannel.id,
    seq: 1,
    payload: {
      ...message(privateChannel.id, "initial-agent-reply", "初始连接期间的 Agent 回复", "1"),
      author: { kind: "agent", id: "agent-1" },
    },
  };

  render(createElement(ChatPage));

  expect(await screen.findByRole("heading", { name: privateChannel.name })).not.toBeNull();
  expect(await screen.findByText("初始连接期间的 Agent 回复")).not.toBeNull();
});

it("loads history only for the selected channel and drops inactive live messages", async () => {
  const user = await openChat();
  const stream = TestEventSource.instances[0]!;

  act(() => {
    stream.emit("message.created", {
      seq: 1,
      kind: "message.created",
      channelId: privateChannel.id,
      payload: message(privateChannel.id, "inactive-live", "未选中频道的临时事件", "1"),
    });
  });
  await user.click(screen.getByRole("button", { name: /私有频道/ }));
  await screen.findByRole("heading", { name: "私有频道" });
  expect(screen.queryByText("未选中频道的临时事件")).toBeNull();

  act(() => {
    stream.emit("message.created", {
      seq: 2,
      kind: "message.created",
      channelId: privateChannel.id,
      payload: message(privateChannel.id, "active-live", "当前频道实时消息", "1"),
    });
  });
  expect(await screen.findByText("当前频道实时消息")).not.toBeNull();

  await user.click(screen.getByRole("button", { name: /公开频道/ }));
  await screen.findByRole("heading", { name: "公开频道" });
  expect(screen.queryByText("当前频道实时消息")).toBeNull();
});

it("validates successful owner responses without losing HTTP error status", async () => {
  const wire = message(publicChannel.id, "parsed", "校验后的消息", "1");
  fixture.fetchMock.mockResolvedValueOnce(json(200, { ...wire, futureField: true }));
  expect(await ownerJSON("/message", messageSchema)).toEqual({ ...wire, futureField: true });
  fixture.fetchMock.mockResolvedValueOnce(json(200, { ...wire, text: 42 }));
  await expect(ownerJSON("/message", messageSchema)).rejects.toThrow("服务器响应无效");
  fixture.fetchMock.mockResolvedValueOnce(json(422, { error: "请求内容无效" }));
  await expect(ownerJSON("/message", messageSchema)).rejects.toMatchObject({
    status: 422,
    message: "请求内容无效",
  });
  fixture.fetchMock.mockResolvedValueOnce(new Response("bad gateway", { status: 502 }));
  await expect(ownerJSON("/message", messageSchema)).rejects.toBeInstanceOf(OwnerRequestError);
  fixture.fetchMock.mockResolvedValueOnce(json(401, {}));
  await expect(ownerJSON("/message", messageSchema)).rejects.toMatchObject({ status: 401 });
  expect(redirectToLogin).toHaveBeenCalledOnce();
});

it("parses channel events and rejects malformed channel updates", async () => {
  await openChat();
  const stream = TestEventSource.instances[0]!;
  const added = { ...publicChannel, id: "new-channel", name: "新增频道", visibility: "private" };
  act(() =>
    stream.emit("channel.created", {
      kind: "channel.created",
      channelId: added.id,
      payload: added,
    }),
  );
  expect(await screen.findByRole("button", { name: /新增频道/ })).not.toBeNull();
  act(() =>
    stream.emit("channel.updated", {
      kind: "channel.updated",
      channelId: added.id,
      payload: { ...added, name: "不合法更新", visibility: "invalid" },
    }),
  );
  expect(screen.queryByRole("button", { name: /不合法更新/ })).toBeNull();
  act(() =>
    stream.emit("channel.updated", {
      kind: "channel.updated",
      channelId: added.id,
      payload: { ...added, name: "改名频道", archived: true },
    }),
  );
  expect(await screen.findByRole("button", { name: /改名频道.*已归档/ })).not.toBeNull();
});

it("reconnects from a fresh snapshot and ignores messages from the closed stream", async () => {
  await openChat();
  const oldStream = TestEventSource.instances[0]!;
  act(() => oldStream.emit("snapshot_required"));
  await waitFor(() => expect(TestEventSource.instances).toHaveLength(2));
  expect(oldStream.closed).toBe(true);
  const incoming = message(publicChannel.id, "fresh-stream", "重连后的消息", "1");
  const envelope = { kind: "message.created", channelId: publicChannel.id, payload: incoming };
  act(() => oldStream.emit("message.created", envelope));
  expect(screen.queryByText(incoming.text)).toBeNull();
  act(() => TestEventSource.instances[1]!.emit("message.created", envelope));
  expect(await screen.findByText(incoming.text)).not.toBeNull();
});

vi.mock("../../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
