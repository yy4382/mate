// @vitest-environment jsdom
// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  fixture,
  TestEventSource,
  publicChannel,
  message,
  json,
  openChat,
  resetFixture,
  cleanupFixture,
} from "../support/chat-fixture.js";
beforeEach(resetFixture);
afterEach(cleanupFixture);

it("offers keyboard and touch reply actions, with the thread in a separate pane", async () => {
  const root = {
    ...message(publicChannel.id, "root-1", "根消息", "1"),
    replyCount: 1,
    recentReplies: [{ ...message(publicChannel.id, "reply-1", "已有讨论", "2"), rootId: "root-1" }],
  };
  fixture.history.set(publicChannel.id, [root, ...root.recentReplies]);
  const user = await openChat();
  const menu = await screen.findByRole("button", { name: "消息 根消息 的操作" });
  menu.focus();
  await user.keyboard("{Enter}");
  await user.click(screen.getByRole("button", { name: "普通回复（引用）" }));
  await user.type(screen.getByRole("textbox", { name: "发送到 公开频道" }), "主时间线答复");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(fixture.positionPosts.at(-1)).toEqual({ quoteId: root.id });
  await user.click(menu);
  await user.click(screen.getByRole("button", { name: "讨论串回复" }));
  expect(await screen.findByRole("complementary", { name: "讨论串" })).not.toBeNull();
  expect(await screen.findByText("已有讨论")).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "消息 已有讨论 的操作" }));
  expect(screen.getByRole("button", { name: "普通回复（引用）" })).not.toBeNull();
  expect(screen.getByRole("button", { name: "讨论串回复" })).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "普通回复（引用）" }));
  await user.type(screen.getByRole("textbox", { name: "发送到 公开频道" }), "引用讨论回复");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(fixture.positionPosts.at(-1)).toEqual({ quoteId: "reply-1" });
  await user.click(screen.getByRole("button", { name: "消息 已有讨论 的操作" }));
  await user.click(screen.getByRole("button", { name: "讨论串回复" }));
  await user.type(screen.getByRole("textbox", { name: "发送到 公开频道" }), "新讨论回复");
  await user.click(screen.getByRole("button", { name: "发送" }));
  expect(fixture.positionPosts.at(-1)).toEqual({ rootId: root.id });
  expect(await screen.findByText("新讨论回复")).not.toBeNull();
});

it("does not count an already loaded thread reply again when its event is replayed", async () => {
  const reply = {
    ...message(publicChannel.id, "reply-existing", "已载入的回复", "2"),
    rootId: "root-replay",
  };
  const root = {
    ...message(publicChannel.id, "root-replay", "重复事件根消息", "1"),
    replyCount: 1,
    recentReplies: [reply],
  };
  fixture.history.set(publicChannel.id, [root, reply]);
  await openChat();
  act(() =>
    TestEventSource.instances[0]!.emit("message.created", {
      seq: 1,
      kind: "message.created",
      channelId: publicChannel.id,
      payload: reply,
    }),
  );
  expect(screen.getByRole("button", { name: /1 条讨论串回复/ })).not.toBeNull();
});

it("ignores a delayed thread response after switching channels", async () => {
  const root = message(publicChannel.id, "slow-root", "慢讨论根消息", "1");
  fixture.history.set(publicChannel.id, [root]);
  let signalStarted!: () => void, release!: (value: Response) => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  const response = new Promise<Response>((resolve) => (release = resolve));
  fixture.nextThreadGate = { rootId: root.id, started, signalStarted, response };
  const user = await openChat();
  await user.click(await screen.findByRole("button", { name: "消息 慢讨论根消息 的操作" }));
  await user.click(screen.getByRole("button", { name: "查看讨论串" }));
  await started;
  await user.click(screen.getByRole("button", { name: /私有频道/ }));
  await act(async () => {
    release(json(200, { root, replies: [] }));
  });
  await waitFor(() => expect(screen.queryByRole("complementary", { name: "讨论串" })).toBeNull());
});

it("keeps the newer thread when an earlier thread request completes last", async () => {
  const first = message(publicChannel.id, "first-root", "第一条根消息", "1");
  const second = message(publicChannel.id, "second-root", "第二条根消息", "2");
  fixture.history.set(publicChannel.id, [first, second]);
  let signalStarted!: () => void, release!: (value: Response) => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  const response = new Promise<Response>((resolve) => (release = resolve));
  fixture.nextThreadGate = { rootId: first.id, started, signalStarted, response };
  const user = await openChat();
  await user.click(await screen.findByRole("button", { name: "消息 第一条根消息 的操作" }));
  await user.click(screen.getByRole("button", { name: "查看讨论串" }));
  await started;
  await user.click(screen.getByRole("button", { name: "消息 第二条根消息 的操作" }));
  await user.click(screen.getByRole("button", { name: "查看讨论串" }));
  expect(await screen.findByRole("complementary", { name: "讨论串" })).not.toBeNull();
  await act(async () => {
    release(json(200, { root: first, replies: [] }));
  });
  expect(screen.getByRole("complementary", { name: "讨论串" }).textContent).toContain(
    "第二条根消息",
  );
});

vi.mock("../../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
