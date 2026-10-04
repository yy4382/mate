// @vitest-environment jsdom
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
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

it("saves profile fields separately and only offers configured model services", async () => {
  fixture.agents = [
    {
      id: "8bfb67a1-66ed-4d56-9052-4cc7eed926ae",
      nodeId,
      name: "Partner",
      role: "Researcher",
      description: "Old",
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
        workspace: "/var/lib/mate/agents/8bfb67a1-66ed-4d56-9052-4cc7eed926ae",
      },
      createdAt: 1,
      updatedAt: 2,
    },
  ];
  fixture.credentials = [{ provider: "openai", configured: true, updatedAt: 3 }];
  render(createElement(AgentsPage));
  const user = userEvent.setup();
  const name = await screen.findByRole("textbox", { name: "Partner 名称" });
  await user.clear(name);
  await user.type(name, "Colleague");
  await user.click(screen.getByRole("button", { name: "保存名称" }));
  await waitFor(() =>
    expect(fixture.agentUpdates).toEqual([
      { path: expect.stringMatching(/\/profile$/), body: { name: "Colleague" } },
    ]),
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: "Colleague 模型服务" }),
    "anthropic",
  );
  expect((screen.getByRole("button", { name: "切换模型" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it("shows a confirmed Agent stop failure with its diagnostic action", async () => {
  fixture.agents = [
    {
      id: "8bfb67a1-66ed-4d56-9052-4cc7eed926ae",
      nodeId,
      name: "Partner",
      role: "Researcher",
      description: "Old",
      model: { provider: "openai", id: "gpt-4.1" },
      initialChannelId: null,
      sessionId,
      status: "ready",
      stage: "complete",
      pausedReason: "manual",
      stop: { state: "failed", receipt: { reason: "process_stop_unconfirmed" } },
      error: null,
      linuxIdentity: {
        username: "mate-node-account",
        uid: 23001,
        gid: 23001,
        workspace: "/var/lib/mate/agents/8bfb67a1-66ed-4d56-9052-4cc7eed926ae",
      },
      createdAt: 1,
      updatedAt: 2,
    },
  ];
  render(createElement(AgentsPage));
  expect(await screen.findByText(/有普通命令的终止无法确认/)).toBeTruthy();
  // A failed stop that proved nothing else must not invent an unproven-command count.
  expect(screen.queryByText(/条命令的终止无法确认；/)).toBeNull();
  expect(screen.queryByText(/停止结果未知/)).toBeNull();
});

it("shows a confirmed one-node-run stop while an earlier command stays unknown", async () => {
  fixture.agents = [
    {
      id: "8bfb67a1-66ed-4d56-9052-4cc7eed926ae",
      nodeId,
      name: "Partner",
      role: "Researcher",
      description: "Old",
      model: { provider: "openai", id: "gpt-4.1" },
      initialChannelId: null,
      sessionId,
      status: "ready",
      stage: "complete",
      pausedReason: "manual",
      stop: {
        state: "succeeded",
        receipt: { stopped: true, operationIds: [], scope: "this_node_run" },
        scope: "this_node_run",
        unconfirmedOperationIds: ["11111111-1111-4111-8111-111111111111"],
      },
      error: null,
      linuxIdentity: {
        username: "mate-node-account",
        uid: 23001,
        gid: 23001,
        workspace: "/var/lib/mate/agents/8bfb67a1-66ed-4d56-9052-4cc7eed926ae",
      },
      createdAt: 1,
      updatedAt: 2,
    },
  ];
  render(createElement(AgentsPage));
  expect(
    await screen.findByText(
      /本次节点运行中可确认的普通命令已停止；另有 1 条命令的终止无法确认。复启前会核对运行账号与 Agent 工作区。/,
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/后台进程/)).toBeNull();
});

vi.mock("../../src/features/agents/agents-page.css", () => ({}));
vi.mock("../../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
