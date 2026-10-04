// @vitest-environment jsdom
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsPage } from "../../../src/features/agents/agents-page.js";

import {
  fixture,
  nodeId,
  sessionId,
  json,
  resetFixture,
  cleanupFixture,
} from "../../support/agents-fixture.js";
beforeEach(resetFixture);
afterEach(cleanupFixture);

it("shows classified stream failures after a standard browser download starts", async () => {
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
        username: "mate_research",
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
      entries: [{ name: "notes.txt", type: "file", size: 5 }],
      nextOffset: null,
    },
  ];
  fixture.workspaceDownloadStatus = { state: "failed", errorCode: "file_changed" };
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(createElement(AgentsPage));
  await userEvent.setup().click(await screen.findByRole("button", { name: "下载" }));

  expect(await screen.findByText("文件在下载期间发生变化，请重新加载后重试。")).not.toBeNull();
  expect(clicked).toHaveBeenCalledOnce();
});

it("shows a Chinese error when a workspace file disappears before download", async () => {
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
        username: "mate_research",
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
      entries: [{ name: "notes.txt", type: "file", size: 5 }],
      nextOffset: null,
    },
  ];
  fixture.workspaceDownloadResponse = json(404, { code: "not_found", error: "文件不存在。" });
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: vi.fn(async () => ({ createWritable: async () => new WritableStream<Uint8Array>() })),
  });
  render(createElement(AgentsPage));
  await userEvent.setup().click(await screen.findByRole("button", { name: "下载" }));
  expect((await screen.findByRole("alert")).textContent).toContain("文件已不存在");
});

it("shows a distinct permission error before starting a workspace download", async () => {
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
        username: "mate_research",
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
      entries: [{ name: "notes.txt", type: "file", size: 5 }],
      nextOffset: null,
    },
  ];
  fixture.workspaceDownloadResponse = json(403, {
    code: "permission_denied",
    error: "当前运行账号没有读取此文件的权限。",
  });
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: vi.fn(async () => ({ createWritable: async () => new WritableStream<Uint8Array>() })),
  });
  render(createElement(AgentsPage));
  await userEvent.setup().click(await screen.findByRole("button", { name: "下载" }));
  // The owner reads what actually happened: the account running Mate could not read the file.
  expect((await screen.findByRole("alert")).textContent).toContain(
    "运行 Mate 的账号没有读取此文件的权限",
  );
});

it("shows a Chinese error when a workspace download stream fails after it starts", async () => {
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
        username: "mate_research",
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
      entries: [{ name: "notes.txt", type: "file", size: 5 }],
      nextOffset: null,
    },
  ];
  fixture.workspaceDownloadResponse = {
    status: 200,
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hel"));
        controller.error(new Error("file_changed during stream"));
      },
    }),
    json: async () => ({}),
  } as Response;
  fixture.workspaceDownloadStatus = { state: "failed", errorCode: "file_changed" };
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: vi.fn(async () => ({ createWritable: async () => new WritableStream<Uint8Array>() })),
  });
  render(createElement(AgentsPage));
  await userEvent.setup().click(await screen.findByRole("button", { name: "下载" }));
  expect((await screen.findByRole("alert")).textContent).toContain("文件在下载期间发生变化");
});

vi.mock("../../../src/features/agents/agents-page.css", () => ({}));
vi.mock("../../../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
