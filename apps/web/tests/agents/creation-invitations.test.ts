// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsPage } from "../../src/features/agents/agents-page.js";

import {
  fixture,
  nodeId,
  channelId,
  sessionId,
  json,
  resetFixture,
  cleanupFixture,
} from "../support/agents-fixture.js";
beforeEach(resetFixture);
afterEach(cleanupFixture);

it("creates a stable request and retries the same workspace request without putting credentials in Agent data", async () => {
  let poll: (() => void) | undefined;
  vi.spyOn(window, "setInterval").mockImplementation(((callback: TimerHandler) => {
    if (typeof callback === "function") poll = callback as () => void;
    return 1;
  }) as typeof window.setInterval);
  const user = userEvent.setup();
  render(createElement(AgentsPage));
  await screen.findByText(/在线节点会在运行账号下创建它的默认工作区和记忆入口/);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Linux 节点" })).toHaveProperty("value", nodeId),
  );

  const providerSelect = screen.getByRole("combobox", { name: "模型提供方" });
  await user.selectOptions(providerSelect, "anthropic");
  expect(
    Array.from((screen.getByRole("combobox", { name: "模型" }) as HTMLSelectElement).options).map(
      (option) => option.value,
    ),
  ).toEqual(["claude-sonnet-4"]);
  await user.selectOptions(providerSelect, "openai");
  expect(screen.queryByRole("textbox", { name: "模型 ID" })).toBeNull();

  await user.type(screen.getByRole("textbox", { name: "名称" }), "Research partner");
  await user.type(screen.getByRole("textbox", { name: "角色" }), "Researches questions");
  await user.type(screen.getByRole("textbox", { name: "介绍" }), "A private colleague.");
  await user.selectOptions(screen.getByRole("combobox", { name: "模型" }), "gpt-4.1");
  await user.selectOptions(screen.getByRole("combobox", { name: "初始频道（可选）" }), channelId);
  expect(screen.getByLabelText("API key").getAttribute("type")).toBe("password");
  await user.click(screen.getByRole("button", { name: "创建 Agent" }));

  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain(
    "节点无法创建 Agent 工作区根路径，请检查运行账号的写入权限。",
  );
  await act(async () => {
    poll?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "节点无法创建 Agent 工作区根路径，请检查运行账号的写入权限。",
  );
  const retry = await screen.findByRole("button", { name: "按同一请求重试" });
  expect(fixture.posts).toHaveLength(1);
  expect(fixture.posts[0]).toMatchObject({
    id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    nodeId,
    name: "Research partner",
    role: "Researches questions",
    model: { provider: "openai", id: "gpt-4.1" },
    initialChannelId: channelId,
  });
  expect(fixture.posts[0]).not.toHaveProperty("apiKeyEnv");

  await user.click(retry);
  await screen.findByText(/配置模型凭据前不会启动运行；邀请频道中的消息会排队/);
  expect(fixture.posts).toHaveLength(2);
  expect(fixture.posts[1]).toEqual(fixture.posts[0]);
  expect(screen.getByText("等待凭据")).toBeTruthy();
  expect(screen.getByText(/默认工作区、记忆入口与会话已验证/)).toBeTruthy();
});

it("lets the owner invite an existing Agent to a channel from the Chinese Agent page", async () => {
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
      status: "waiting_credentials",
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
  render(createElement(AgentsPage));
  await screen.findByRole("heading", { name: "Research partner" });
  await userEvent
    .setup()
    .selectOptions(screen.getByRole("combobox", { name: "Research partner 邀请频道" }), channelId);
  await userEvent.setup().click(screen.getByRole("button", { name: "邀请加入" }));

  await screen.findByText("Research partner 已加入频道。");
  expect(fixture.invitationPosts).toEqual([
    {
      url: `/api/owner/channels/${channelId}/invitations`,
      body: { agentId },
    },
  ]);
});

it("keeps a no-record node conflict visible through refreshes until the owner starts a new request", async () => {
  let poll: (() => void) | undefined;
  vi.spyOn(window, "setInterval").mockImplementation(((callback: TimerHandler) => {
    if (typeof callback === "function") poll = callback as () => void;
    return 1;
  }) as typeof window.setInterval);
  const user = userEvent.setup();
  render(createElement(AgentsPage));
  await screen.findByText(/在线节点会在运行账号下创建它的默认工作区和记忆入口/);
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Linux 节点" })).toHaveProperty("value", nodeId),
  );

  await user.type(screen.getByRole("textbox", { name: "名称" }), "Offline colleague");
  await user.type(screen.getByRole("textbox", { name: "角色" }), "Waits for the node");
  await user.selectOptions(screen.getByRole("combobox", { name: "模型" }), "gpt-4.1");
  fixture.postConflict = true;
  await user.click(screen.getByRole("button", { name: "创建 Agent" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("节点已离线，Agent 资料尚未提交。");
  expect(screen.queryByText("Agent 创建失败")).toBeNull();
  expect(fixture.posts).toHaveLength(1);
  await act(async () => {
    poll?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.getByRole("alert").textContent).toBe("节点已离线，Agent 资料尚未提交。");
  expect(screen.getByRole("button", { name: "创建 Agent" })).toHaveProperty("disabled", true);

  await user.click(screen.getByRole("button", { name: "新建资料" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps malformed node responses out of Agent state and shows the existing Chinese read error", async () => {
  fixture.fetchMock.mockImplementationOnce(async () =>
    json(200, { nodes: [{ id: 7, online: true, lastConnectedAt: null }] }),
  );
  render(createElement(AgentsPage));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "暂时无法读取控制面资料。",
  );
  expect(screen.queryByRole("option", { name: "在线 · 7" })).toBeNull();
});

vi.mock("../../src/features/agents/agents-page.css", () => ({}));
vi.mock("../../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
