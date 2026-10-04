// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ChatPage } from "../../src/features/conversations/chat-page.js";

const root = {
  id: "old-root",
  channelId: "room",
  rootId: null,
  author: { kind: "agent", id: "agent" },
  text: "旧消息",
  order: "1",
  createdAt: 1,
};
const reply = { ...root, id: "thread-reply", rootId: root.id, text: "讨论串提及", order: "2" };

class QuietEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {}
  addEventListener(_name: string, _listener: EventListener) {}
  close() {}
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

async function land(
  target: { messageId: string },
  context?: unknown,
  expectFallback = false,
): Promise<{ scrolled: string[]; requested: string[] }> {
  const targetId = `message-${target.messageId}`;
  window.history.replaceState({}, "", `/app?channel=room&message=${target.messageId}`);
  const scrolled: string[] = [];
  const requested: string[] = [];
  Element.prototype.scrollIntoView = function () {
    scrolled.push(this.id);
  };
  vi.stubGlobal("EventSource", QuietEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const path = String(input);
      requested.push(path);
      if (path.endsWith(`/messages/${target.messageId}/context`) && context instanceof Error)
        throw context;
      const body =
        path === "/api/owner/session"
          ? { authenticated: true }
          : path === "/api/owner/snapshot"
            ? {
                channels: [
                  {
                    id: "room",
                    name: "频道",
                    description: "",
                    visibility: "public",
                    archived: false,
                    createdAt: 1,
                    updatedAt: 1,
                  },
                  {
                    id: "other",
                    name: "别处",
                    description: "",
                    visibility: "public",
                    archived: false,
                    createdAt: 1,
                    updatedAt: 1,
                  },
                ],
                cursor: 0,
              }
            : path.endsWith(`/messages/${target.messageId}/context`)
              ? context === null
                ? { error: "消息不存在" }
                : context
              : path === "/api/owner/tasks"
                ? { tasks: [] }
                : path === "/api/owner/agents"
                  ? { agents: [] }
                  : path.endsWith("/attachments")
                    ? { attachments: [] }
                    : { messages: [root], nextBefore: null };
      return Response.json(body, {
        status:
          path.endsWith(`/messages/${target.messageId}/context`) && context === null ? 404 : 200,
      });
    }),
  );
  render(<ChatPage />);
  if (context === null || context instanceof Error || expectFallback)
    await waitFor(() => expect(document.getElementById(`message-${root.id}`)).not.toBeNull());
  else await waitFor(() => expect(scrolled).toContain(targetId));
  return { scrolled, requested };
}

it("opens an older timeline page and scrolls to the notified message", async () => {
  const { scrolled } = await land(
    { messageId: root.id },
    {
      kind: "timeline",
      messageId: root.id,
      page: { messages: [root], nextBefore: null },
      hasNewer: true,
    },
  );
  expect(document.getElementById(`message-${root.id}`)?.textContent).toContain("旧消息");
  expect(scrolled).toEqual([`message-${root.id}`]);
});

it("opens a thread and scrolls to the notified reply", async () => {
  const { scrolled } = await land(
    { messageId: reply.id },
    {
      kind: "thread",
      messageId: reply.id,
      thread: { root, replies: [reply] },
    },
  );
  expect(document.getElementById(`message-${reply.id}`)?.textContent).toContain("讨论串提及");
  expect(scrolled).toEqual([`message-${reply.id}`]);
  fireEvent.click(document.querySelectorAll(".channel-row")[1]!);
  await waitFor(() => expect(document.querySelector(".thread-panel")).toBeNull());
  fireEvent.click(document.querySelectorAll(".channel-row")[0]!);
  await waitFor(() => expect(document.getElementById(`message-${root.id}`)).not.toBeNull());
  expect(document.querySelector(".thread-panel")).toBeNull();
  expect(
    vi
      .mocked(fetch)
      .mock.calls.filter(([path]) => String(path).endsWith(`/messages/${reply.id}/context`)),
  ).toHaveLength(1);
});

it("shows no approval card and asks no approval endpoint while a channel is open", async () => {
  const { requested } = await land({ messageId: root.id }, null);
  // The page really is up with the channel's messages, so the absences below are about a page
  // that rendered, not one that never got anywhere.
  expect(document.getElementById(`message-${root.id}`)?.textContent).toContain("旧消息");
  expect(requested).toContain("/api/owner/snapshot");
  expect(document.querySelector(".approval-card")).toBeNull();
  for (const approvalText of ["系统特权命令", "批准执行", "等待你的审批"])
    expect(document.body.textContent).not.toContain(approvalText);
  expect(requested.filter((path) => path.includes("/approvals"))).toEqual([]);
});

for (const failure of [null, new Error("network down")]) {
  it(`shows the latest messages and a visible notice when the target ${failure ? "cannot be fetched" : "is gone"}`, async () => {
    await land({ messageId: "missing-message" }, failure);
    expect(document.querySelector(".chat-shell")?.getAttribute("data-mobile-view")).toBe("chat");
    expect(document.querySelector('.conversation-panel [role="alert"]')?.textContent).toContain(
      "通知中的消息",
    );
    expect(document.getElementById(`message-${root.id}`)?.textContent).toContain("旧消息");
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([path]) => String(path).endsWith("/messages/missing-message/context")),
    ).toHaveLength(1);
  });
}

it.each([
  { kind: "unknown", messageId: "malformed-message" },
  {
    kind: "timeline",
    messageId: "malformed-message",
    page: { messages: [{ ...root, order: "invalid" }], nextBefore: null },
    hasNewer: true,
  },
  { kind: "thread", messageId: "malformed-message", thread: { root, replies: [null] } },
])(
  "falls back to latest messages when a successful context response is malformed",
  async (context) => {
    const { requested } = await land({ messageId: "malformed-message" }, context, true);
    expect(document.querySelector('.conversation-panel [role="alert"]')?.textContent).toContain(
      "通知中的消息",
    );
    expect(document.getElementById(`message-${root.id}`)?.textContent).toContain("旧消息");
    expect(
      requested.filter((path) => path.endsWith("/messages/malformed-message/context")),
    ).toHaveLength(1);
  },
);
