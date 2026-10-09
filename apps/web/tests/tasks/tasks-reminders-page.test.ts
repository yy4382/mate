// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TasksPage } from "../../src/features/tasks/tasks-page.js";
import { RemindersPage } from "../../src/features/reminders/reminders-page.js";
vi.mock("../../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (body: unknown) => Response.json(body);

it("shows the canonical task card and its activity without adding chat text", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/activity")
        ? json({
            events: [
              {
                seq: 1,
                actorKind: "agent",
                actorId: "peer",
                kind: "claimed",
                note: "",
                createdAt: 1,
              },
            ],
          })
        : json({
            tasks: [
              {
                id: "task-1",
                messageId: "message-1",
                channelId: "channel-1",
                title: "Review deployment",
                status: "in_progress",
                ownerAgentId: "peer",
                version: 2,
                updatedAt: 1,
              },
              {
                id: "task-2",
                messageId: "message-1",
                channelId: "channel-1",
                title: "Write deployment notes",
                status: "open",
                ownerAgentId: null,
                version: 1,
                updatedAt: 1,
              },
              {
                id: "task-reply",
                messageId: "reply-1",
                channelId: "channel-1",
                title: "Verify thread reply",
                status: "done",
                ownerAgentId: "peer-2",
                version: 2,
                updatedAt: 1,
              },
            ],
          }),
    ),
  );
  render(createElement(TasksPage));
  await userEvent.setup().click(await screen.findByRole("button", { name: "Review deployment" }));
  expect(await screen.findByText(/claimed · peer/)).not.toBeNull();
  expect(screen.getByRole("button", { name: "Write deployment notes" })).not.toBeNull();
  expect(screen.getByRole("button", { name: "Verify thread reply" })).not.toBeNull();
  expect(
    screen.getAllByRole("link", { name: "查看原消息" }).map((link) => link.getAttribute("href")),
  ).toEqual([
    "/app?channel=channel-1&message=message-1",
    "/app?channel=channel-1&message=message-1",
    "/app?channel=channel-1&message=reply-1",
  ]);
});

it("shows an unrun firing as pending and exposes no owner mutation control", async () => {
  window.history.replaceState({}, "", "/app/agents/agent-1/reminders");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        reminders: [
          {
            id: "reminder-1",
            text: "Check again",
            dueAt: 1000,
            state: "fired",
            firing: { firedAt: 1000, handledAt: null },
          },
        ],
      }),
    ),
  );
  render(createElement(RemindersPage));
  expect(await screen.findByText(/已触发，等待 Agent 处理/)).not.toBeNull();
  expect(screen.queryByRole("button", { name: /取消|改期/ })).toBeNull();
});
