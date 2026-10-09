// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  fixture,
  TestEventSource,
  publicChannel,
  privateChannel,
  failNextLatestHistoryRequest,
  message,
  openChat,
  resetFixture,
  cleanupFixture,
} from "../support/chat-fixture.js";
beforeEach(resetFixture);
afterEach(cleanupFixture);

it("bounds the loaded window while preserving older-page and return-to-latest navigation", async () => {
  fixture.history.set(
    publicChannel.id,
    Array.from({ length: 200 }, (_, index) =>
      message(publicChannel.id, `history-${index + 1}`, `历史消息 ${index + 1}`, String(index + 1)),
    ),
  );
  const user = await openChat();

  for (const firstOrder of [101, 51, 1]) {
    await user.click(await screen.findByRole("button", { name: "加载更早消息" }));
    expect(await screen.findByText(`历史消息 ${firstOrder}`)).not.toBeNull();
  }
  expect(document.querySelectorAll(".message-row")).toHaveLength(200);
  expect(screen.getByText("历史消息 1")).not.toBeNull();
  expect(screen.getByText("历史消息 200")).not.toBeNull();

  const liveMessages = Array.from({ length: 5 }, (_, index) => {
    const order = index + 201;
    return message(publicChannel.id, `live-${order}`, `实时消息 ${order}`, String(order));
  });
  fixture.history.set(publicChannel.id, [
    ...(fixture.history.get(publicChannel.id) ?? []),
    ...liveMessages,
  ]);
  act(() => {
    liveMessages.forEach((payload, index) => {
      TestEventSource.instances[0]!.emit("message.created", {
        seq: index + 1,
        kind: "message.created",
        channelId: publicChannel.id,
        payload,
      });
    });
  });

  await waitFor(() => expect(document.querySelectorAll(".message-row")).toHaveLength(200));
  expect(screen.queryByText("历史消息 1")).toBeNull();
  expect(screen.getByText("历史消息 6")).not.toBeNull();
  expect(screen.getByText("实时消息 205")).not.toBeNull();

  await user.click(await screen.findByRole("button", { name: "加载更早消息" }));
  expect(await screen.findByText("历史消息 1")).not.toBeNull();
  expect(screen.getByRole("button", { name: "返回最新消息" })).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "返回最新消息" }));
  expect(await screen.findByText("历史消息 156")).not.toBeNull();
  expect(screen.getByText("实时消息 205")).not.toBeNull();
  expect(screen.queryByText("历史消息 1")).toBeNull();
  expect(document.querySelectorAll(".message-row")).toHaveLength(50);
});

it("keeps a return-to-latest path after sending from an older message window", async () => {
  fixture.history.set(
    publicChannel.id,
    Array.from({ length: 250 }, (_, index) =>
      message(publicChannel.id, `history-${index + 1}`, `历史消息 ${index + 1}`, String(index + 1)),
    ),
  );
  const user = await openChat();

  for (const firstOrder of [151, 101, 51, 1]) {
    await user.click(await screen.findByRole("button", { name: "加载更早消息" }));
    expect(await screen.findByText(`历史消息 ${firstOrder}`)).not.toBeNull();
  }
  expect(document.querySelectorAll(".message-row")).toHaveLength(200);
  expect(screen.getByText("历史消息 1")).not.toBeNull();
  expect(screen.getByText("历史消息 200")).not.toBeNull();
  expect(screen.queryByText("历史消息 201")).toBeNull();

  await user.type(screen.getByRole("textbox", { name: "发送到 公开频道" }), "新消息251");
  await user.click(screen.getByRole("button", { name: "发送" }));

  expect(await screen.findByText("新消息251")).not.toBeNull();
  expect(fixture.posts).toEqual([{ channelId: publicChannel.id, text: "新消息251" }]);
  expect(document.querySelectorAll(".message-row").length).toBeLessThanOrEqual(200);
  await user.click(screen.getByRole("button", { name: "返回最新消息" }));
  expect(await screen.findByText("历史消息 202")).not.toBeNull();
  expect(screen.getByText("新消息251")).not.toBeNull();
  expect(screen.queryByText("历史消息 1")).toBeNull();
  expect(document.querySelectorAll(".message-row")).toHaveLength(50);
});

it("ignores a failed latest-page request after switching to another channel", async () => {
  fixture.history.set(
    publicChannel.id,
    Array.from({ length: 250 }, (_, index) =>
      message(publicChannel.id, `history-${index + 1}`, `A 消息 ${index + 1}`, String(index + 1)),
    ),
  );
  fixture.history.set(privateChannel.id, [
    message(privateChannel.id, "private-1", "B 的消息", "1"),
  ]);
  const user = await openChat();

  for (const firstOrder of [151, 101, 51, 1]) {
    await user.click(await screen.findByRole("button", { name: "加载更早消息" }));
    expect(await screen.findByText(`A 消息 ${firstOrder}`)).not.toBeNull();
  }
  const gate = failNextLatestHistoryRequest(publicChannel.id);
  await user.click(screen.getByRole("button", { name: "返回最新消息" }));
  await gate.started;
  expect(screen.getByRole("button", { name: /正在读取最新消息/ })).not.toBeNull();

  await user.click(screen.getByRole("button", { name: /私有频道/ }));
  expect(await screen.findByText("B 的消息")).not.toBeNull();
  expect(screen.queryByRole("button", { name: /正在读取最新消息/ })).toBeNull();
  await act(async () => {
    gate.fail();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.getByText("B 的消息")).not.toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.querySelectorAll(".message-row")).toHaveLength(1);
});

vi.mock("../../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
