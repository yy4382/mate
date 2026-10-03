// @vitest-environment jsdom
// @vitest-environment jsdom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";

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

it("offers task sending and creating from an existing message with a visible task card", async () => {
  const user = await openChat();
  await user.type(screen.getByRole("textbox", { name: "发送到 公开频道" }), "Prepare the release");
  await user.click(screen.getByRole("checkbox", { name: "作为任务发送" }));
  await user.click(screen.getByRole("button", { name: "发送", exact: true }));
  await waitFor(() => expect(fixture.taskPosts).toContainEqual({ asTask: true }));
  expect(await screen.findByText(/任务 · 待认领/)).not.toBeNull();
  await user.type(screen.getByRole("textbox", { name: "发送到 公开频道" }), "Follow up later");
  await user.click(screen.getByRole("button", { name: "发送", exact: true }));
  await user.click(screen.getByRole("button", { name: "消息 Follow up later 的操作" }));
  await user.click(screen.getByRole("button", { name: "从消息建任务" }));
  await user.click(screen.getByRole("button", { name: "创建任务", exact: true }));
  await waitFor(() =>
    expect(fixture.taskPosts).toContainEqual({ messageId: "message-2", title: "Follow up later" }),
  );
  expect(screen.getAllByText(/任务 · 待认领/)).toHaveLength(2);
});

it("creates titled tasks repeatedly on the root and reply and shows every title, owner and state in its own position", async () => {
  const root = message(publicChannel.id, "root-task", "根消息的多个事项", "1");
  const reply = {
    ...message(publicChannel.id, "reply-task", "回复里的多个事项", "2"),
    rootId: root.id,
  };
  fixture.history.set(publicChannel.id, [root, reply]);
  fixture.tasks.push({
    id: "existing-root",
    messageId: root.id,
    channelId: publicChannel.id,
    title: "既有根任务",
    status: "in_progress",
    ownerAgentId: "agent-1",
    ownerAgentName: "同事甲",
  });
  const user = await openChat();
  await user.click(screen.getByRole("button", { name: `消息 ${root.text} 的操作` }));
  await user.click(screen.getByRole("button", { name: "从消息建任务" }));
  const title = screen.getByRole("textbox", { name: "任务标题" });
  expect((title as HTMLInputElement).value).toBe(root.text);
  await user.clear(title);
  await user.type(title, "  新的根任务  ");
  await user.click(screen.getByRole("button", { name: "创建任务", exact: true }));
  await waitFor(() =>
    expect(fixture.taskPosts).toContainEqual({ messageId: root.id, title: "新的根任务" }),
  );
  await user.click(screen.getByRole("button", { name: `消息 ${root.text} 的操作` }));
  await user.click(screen.getByRole("button", { name: "查看讨论串" }));
  const thread = await screen.findByRole("complementary", { name: "讨论串" });
  const threadRoot = thread.querySelector(".thread-root")!;
  expect(threadRoot.textContent).toContain("既有根任务");
  expect(threadRoot.textContent).toContain("新的根任务");
  expect(threadRoot.textContent).toContain("同事甲");
  expect(threadRoot.textContent).toContain("进行中");
  await user.click(within(thread).getByRole("button", { name: "从消息建任务", exact: true }));
  await user.clear(screen.getByRole("textbox", { name: "任务标题" }));
  await user.type(screen.getByRole("textbox", { name: "任务标题" }), "根消息第三项");
  await user.click(screen.getByRole("button", { name: "创建任务", exact: true }));
  for (const titleText of ["回复第一项", "回复第二项"]) {
    await user.click(within(thread).getByRole("button", { name: `消息 ${reply.text} 的操作` }));
    await user.click(
      within(thread.querySelector(`#message-${reply.id}`) as HTMLElement).getByRole("button", {
        name: "从消息建任务",
        exact: true,
      }),
    );
    await user.clear(screen.getByRole("textbox", { name: "任务标题" }));
    await user.type(screen.getByRole("textbox", { name: "任务标题" }), titleText);
    await user.click(screen.getByRole("button", { name: "创建任务", exact: true }));
    await waitFor(() =>
      expect(fixture.taskPosts).toContainEqual({ messageId: reply.id, title: titleText }),
    );
  }
  const replyRow = thread.querySelector(`#message-${reply.id}`)!;
  expect(replyRow.textContent).toContain("回复第一项");
  expect(replyRow.textContent).toContain("回复第二项");
  expect(replyRow.textContent).toContain("待认领");
  expect(replyRow.textContent).not.toContain("既有根任务");
  expect(threadRoot.textContent).not.toContain("回复第一项");
  expect(fixture.tasks.filter((task) => task.messageId === root.id)).toHaveLength(3);
  expect(fixture.tasks.filter((task) => task.messageId === reply.id)).toHaveLength(2);
  cleanup();
  TestEventSource.instances = [];
  await openChat();
  expect(await screen.findByText(/根消息第三项/)).not.toBeNull();
  expect(screen.queryByText(/回复第一项/)).toBeNull();
});

it("keeps a newer task form open when an earlier message's create finishes", async () => {
  const first = message(publicChannel.id, "first-task-source", "第一项工作的消息", "1");
  const second = message(publicChannel.id, "second-task-source", "第二项工作的消息", "2");
  fixture.history.set(publicChannel.id, [first, second]);
  const handleFetch = fixture.fetchMock.getMockImplementation()!;
  let signalStarted!: () => void, release!: () => void;
  let signalSecondStarted!: () => void, releaseSecond!: () => void;
  const started = new Promise<void>((resolve) => (signalStarted = resolve));
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const secondStarted = new Promise<void>((resolve) => (signalSecondStarted = resolve));
  const secondWaiting = new Promise<void>((resolve) => (releaseSecond = resolve));
  fixture.fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await handleFetch(input, init);
    if (String(input) === "/api/owner/tasks" && init?.method === "POST") {
      if (JSON.parse(String(init.body)).messageId === first.id) {
        signalStarted();
        await waiting;
      } else {
        signalSecondStarted();
        await secondWaiting;
      }
    }
    return response;
  });
  const user = await openChat();
  await user.click(screen.getByRole("button", { name: `消息 ${first.text} 的操作` }));
  await user.click(screen.getByRole("button", { name: "从消息建任务" }));
  await user.click(screen.getByRole("button", { name: "创建任务", exact: true }));
  await started;

  await user.click(screen.getByRole("button", { name: `消息 ${second.text} 的操作` }));
  await user.click(screen.getByRole("button", { name: "从消息建任务" }));
  const title = screen.getByRole("textbox", { name: "任务标题" });
  await user.clear(title);
  await user.type(title, "继续编辑第二项任务");
  await user.click(screen.getByRole("button", { name: "创建任务", exact: true }));
  await secondStarted;
  await act(async () => release());

  expect((screen.getByRole("textbox", { name: "任务标题" }) as HTMLInputElement).value).toBe(
    "继续编辑第二项任务",
  );
  expect(document.getElementById(`message-${first.id}`)?.textContent).toContain(
    `任务 · 待认领 · ${first.text}`,
  );
  expect(
    (screen.getByRole("button", { name: "创建任务", exact: true }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await act(async () => releaseSecond());
  await waitFor(() => expect(screen.queryByRole("form", { name: "创建任务" })).toBeNull());
  expect(fixture.taskPosts).toEqual([
    { messageId: first.id, title: first.text },
    { messageId: second.id, title: "继续编辑第二项任务" },
  ]);
  expect(document.getElementById(`message-${second.id}`)?.textContent).toContain(
    "任务 · 待认领 · 继续编辑第二项任务",
  );
});

it.each(["network", "invalid", "malformed", "unreadable", "gateway"] as const)(
  "reports an unconfirmed create truthfully after a %s response loss and does not automatically repeat it",
  async (fault) => {
    const root = message(publicChannel.id, "uncertain-task", "可能已经提交的事项", "1");
    fixture.history.set(publicChannel.id, [root]);
    const user = await openChat();
    await user.click(await screen.findByRole("button", { name: `消息 ${root.text} 的操作` }));
    await user.click(screen.getByRole("button", { name: "从消息建任务" }));
    fixture.loseNextTaskResponse = fault;
    await user.click(screen.getByRole("button", { name: "创建任务", exact: true }));
    expect((await screen.findByRole("alert")).textContent).toContain("提交结果未确认");
    expect(screen.getByRole("alert").textContent).toContain("可能已创建");
    expect(fixture.taskPosts).toEqual([{ messageId: root.id, title: root.text }]);
    expect(fixture.tasks).toHaveLength(1);
    cleanup();
    TestEventSource.instances = [];
    await openChat();
    expect(await screen.findByText(/任务 · 待认领/)).not.toBeNull();
    expect(fixture.taskPosts).toHaveLength(1);
    // The owner can still deliberately record another task with the same title.
    await user.click(screen.getByRole("button", { name: `消息 ${root.text} 的操作` }));
    await user.click(screen.getByRole("button", { name: "从消息建任务" }));
    await user.click(screen.getByRole("button", { name: "创建任务", exact: true }));
    await waitFor(() => expect(fixture.taskPosts).toHaveLength(2));
    expect(fixture.tasks).toHaveLength(2);
  },
);

it("shows a known task rejection without calling it an uncertain submission", async () => {
  const root = message(publicChannel.id, "rejected-task", "未获准创建的事项", "1");
  fixture.history.set(publicChannel.id, [root]);
  const user = await openChat();
  const handleFetch = fixture.fetchMock.getMockImplementation()!;
  fixture.fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === "/api/owner/tasks" && init?.method === "POST"
      ? Promise.resolve(json(403, { error: "无法在此消息创建任务" }))
      : handleFetch(input, init),
  );
  await user.click(screen.getByRole("button", { name: `消息 ${root.text} 的操作` }));
  await user.click(screen.getByRole("button", { name: "从消息建任务" }));
  await user.click(screen.getByRole("button", { name: "创建任务", exact: true }));
  expect((await screen.findByRole("alert")).textContent).toBe("无法在此消息创建任务");
  expect(screen.getByRole("form", { name: "创建任务" })).not.toBeNull();
  expect(fixture.taskPosts).toHaveLength(0);
});

vi.mock("../../src/features/conversations/chat.css", () => ({}));
vi.mock("../../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
