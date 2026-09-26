// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { TasksPage } from "../src/tasks-page.js";
import { RemindersPage } from "../src/reminders-page.js";
vi.mock("../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (body: unknown) => ({ status: 200, ok: true, json: async () => body }) as Response;

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
            ],
          }),
    ),
  );
  render(createElement(TasksPage));
  await userEvent.setup().click(await screen.findByRole("button", { name: "Review deployment" }));
  expect(await screen.findByText(/claimed · peer/)).not.toBeNull();
  expect(screen.getByRole("link", { name: "查看原消息" }).getAttribute("href")).toContain(
    "channel-1",
  );
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
