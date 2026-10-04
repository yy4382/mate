// @vitest-environment jsdom
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsPage } from "../../src/features/agents/agents-page.js";

import {
  fixture,
  nodeId,
  sessionId,
  resetFixture,
  cleanupFixture,
} from "../support/agents-fixture.js";
beforeEach(resetFixture);
afterEach(cleanupFixture);

it("browses an Agent default workspace read-only, previews and streams downloads, and loads every directory page", async () => {
  const agentId = "8bfb67a1-66ed-4d56-9052-4cc7a41c60b9";
  fixture.agents = [
    {
      id: agentId,
      nodeId,
      name: "Research partner",
      role: "Researches questions",
      description: "A colleague",
      model: { provider: "openai", id: "gpt-4.1" },
      initialChannelId: null,
      sessionId,
      status: "ready",
      stage: "complete",
      error: null,
      linuxIdentity: {
        username: "mate-node-account",
        uid: 23001,
        gid: 23001,
        workspace: `/var/lib/mate/agents/${agentId}`,
      },
      createdAt: 1,
      updatedAt: 2,
    },
  ];
  fixture.workspacePages = [
    {
      path: "",
      offset: 0,
      entries: [
        { name: "notes.txt", type: "file", size: 5 },
        { name: "projects", type: "directory", size: 0 },
        { name: "shortcut", type: "symlink", size: 0 },
      ],
      nextOffset: 3,
    },
    {
      path: "",
      offset: 3,
      entries: [{ name: "tail.txt", type: "file", size: 1 }],
      nextOffset: null,
    },
    {
      path: "projects",
      offset: 0,
      entries: [{ name: "plan.md", type: "file", size: 5 }],
      nextOffset: null,
    },
  ];

  const user = userEvent.setup();
  render(createElement(AgentsPage));
  expect(await screen.findByRole("heading", { name: "默认工作区" })).not.toBeNull();
  expect(await screen.findByRole("button", { name: /notes.txt/ })).not.toBeNull();
  expect(screen.getByText(/符号链接，不跟随/)).not.toBeNull();
  expect(screen.queryByRole("button", { name: /上传|删除|编辑/ })).toBeNull();

  await user.click(screen.getByRole("button", { name: /notes.txt/ }));
  expect(await screen.findByText("hello")).not.toBeNull();
  const written: Uint8Array[] = [];
  vi.stubGlobal("showSaveFilePicker", undefined);
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: vi.fn(async () => ({
      createWritable: async () =>
        new WritableStream<Uint8Array>({ write: (chunk) => written.push(chunk) }),
    })),
  });
  await user.click(screen.getByRole("button", { name: "下载" }));
  expect(await screen.findByText("下载完成。")).not.toBeNull();
  expect(Buffer.concat(written.map((chunk) => Buffer.from(chunk))).toString()).toBe("hello");

  await user.click(screen.getByRole("button", { name: "加载更多目录项" }));
  expect(await screen.findByRole("button", { name: /tail.txt/ })).not.toBeNull();
  expect(fixture.fetchMock.mock.calls.some(([input]) => String(input).includes("offset=3"))).toBe(
    true,
  );

  fixture.agents = fixture.agents.map((agent) => ({
    ...agent,
    description: "Status refreshed without changing the workspace",
  }));
  await screen.findByDisplayValue("Status refreshed without changing the workspace", undefined, {
    timeout: 4500,
  });
  expect(screen.getByRole("button", { name: /tail.txt/ })).not.toBeNull();

  await user.click(screen.getByRole("button", { name: /projects\// }));
  expect(await screen.findByRole("button", { name: /plan.md/ })).not.toBeNull();
});

it("shows the last connection time when a workspace request discovers that the node went offline", async () => {
  const agentId = "8bfb67a1-66ed-4d56-9052-4cc7a41c60b9",
    lastConnectedAt = "2026-09-26T03:04:05.000Z";
  fixture.agents = [
    {
      id: agentId,
      nodeId,
      name: "Research partner",
      role: "Researches questions",
      description: "A colleague",
      model: { provider: "openai", id: "gpt-4.1" },
      initialChannelId: null,
      sessionId,
      status: "ready",
      stage: "complete",
      error: null,
      linuxIdentity: {
        username: "mate-node-account",
        uid: 23001,
        gid: 23001,
        workspace: `/var/lib/mate/agents/${agentId}`,
      },
      createdAt: 1,
      updatedAt: 2,
    },
  ];
  fixture.workspaceFailure = {
    status: 503,
    body: {
      error: "节点当前离线，工作区暂不可用。",
      code: "node_offline",
      lastConnectedAt,
    },
  };
  render(createElement(AgentsPage));

  expect(await screen.findByRole("alert")).not.toBeNull();
  expect(screen.getByText(/节点离线，工作区暂不可用/)).not.toBeNull();
  expect(screen.getByText(/最后连接：/)).not.toBeNull();
  expect(screen.queryByRole("list", { name: "工作区目录" })).toBeNull();
});

vi.mock("../../src/features/agents/agents-page.css", () => ({}));
vi.mock("../../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
