// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ChatPage } from "../src/chat-app.js";

const root = {
  id: "old-root",
  channelId: "room",
  rootId: null,
  author: { kind: "agent", id: "agent" },
  text: "旧消息",
  order: "1",
  revision: "1",
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

async function land(target: { messageId?: string; approvalId?: string }, context?: unknown) {
  const targetId = target.messageId
    ? `message-${target.messageId}`
    : `approval-${target.approvalId}`;
  window.history.replaceState(
    {},
    "",
    `/app?channel=room&${target.messageId ? `message=${target.messageId}` : `approval=${target.approvalId}`}`,
  );
  const scrolled: string[] = [];
  Element.prototype.scrollIntoView = function () {
    scrolled.push(this.id);
  };
  vi.stubGlobal("EventSource", QuietEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const path = String(input);
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
                ],
                cursor: 0,
              }
            : target.messageId && path.endsWith(`/messages/${target.messageId}/context`)
              ? context
              : path === "/api/owner/tasks"
                ? { tasks: [] }
                : path === "/api/owner/agents"
                  ? { agents: [] }
                  : path.endsWith("/attachments")
                    ? { attachments: [] }
                    : path.endsWith("/approvals")
                      ? {
                          approvals: target.approvalId
                            ? [
                                {
                                  requestId: target.approvalId,
                                  operationId: "operation",
                                  agentId: "agent",
                                  nodeId: "node",
                                  channelId: "room",
                                  program: "/usr/bin/id",
                                  args: [],
                                  cwd: "/tmp",
                                  expiresAt: Date.now() + 60_000,
                                  createdAt: Date.now(),
                                  state: "pending",
                                  receipt: null,
                                  nodeOnline: false,
                                  nodeLastConnectedAt: null,
                                },
                              ]
                            : [],
                        }
                      : { messages: [], nextBefore: null };
      return Response.json(body);
    }),
  );
  render(<ChatPage />);
  await waitFor(() => expect(scrolled).toContain(targetId));
  return scrolled;
}

it("opens an older timeline page and scrolls to the notified message", async () => {
  const scrolled = await land(
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
  const scrolled = await land(
    { messageId: reply.id },
    {
      kind: "thread",
      messageId: reply.id,
      thread: { root, replies: [reply] },
    },
  );
  expect(document.getElementById(`message-${reply.id}`)?.textContent).toContain("讨论串提及");
  expect(scrolled).toEqual([`message-${reply.id}`]);
});

it("lands on the original approval card after the login return URL is restored", async () => {
  const scrolled = await land({ approvalId: "request-1" });
  expect(document.getElementById("approval-request-1")?.textContent).toContain("等待你的审批");
  expect(scrolled).toEqual(["approval-request-1"]);
});
