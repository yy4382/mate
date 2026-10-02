// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentActivity } from "../src/features/agents/agent-activity.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows offline confirmed facts safely until the owner expands operation detail", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      return {
        ok: true,
        json: async () => ({
          nodeOnline: false,
          pausedReason: null,
          nextBefore: null,
          events: [
            {
              sequence: 1,
              kind: "operation.finished",
              referenceId: "op-1",
              summary: "操作完成",
              ...(url.includes("detail=1") ? { detail: { command: "PRIVATE_ARGUMENT" } } : {}),
              at: 1,
            },
          ],
        }),
      } as Response;
    }),
  );
  const user = userEvent.setup();
  render(createElement(AgentActivity, { agentId: "agent-1" }));
  await user.click(screen.getByRole("button", { name: "查看动态" }));
  await waitFor(() => expect(screen.getByText("操作完成")).toBeTruthy());
  expect(screen.getByText("节点离线 · 以下为最后已确认事实")).toBeTruthy();
  expect(screen.queryByText(/PRIVATE_ARGUMENT/)).toBeNull();
  expect(requests).toEqual(["/api/owner/agents/agent-1/activity"]);
  await user.click(screen.getByRole("button", { name: "展开详情" }));
  await waitFor(() => expect(screen.getByText(/PRIVATE_ARGUMENT/)).toBeTruthy());
  expect(requests.at(-1)).toBe("/api/owner/agents/agent-1/activity?detail=1");
});

it("labels a confirmed stop failure separately from an unknown result", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        nodeOnline: true,
        pausedReason: "manual",
        stop: { state: "failed", receipt: { reason: "process_stop_unconfirmed" } },
        nextBefore: null,
        events: [],
      }),
    })),
  );
  const user = userEvent.setup();
  render(createElement(AgentActivity, { agentId: "agent-1" }));
  await user.click(screen.getByRole("button", { name: "查看动态" }));
  expect(await screen.findByText(/有普通命令的终止无法确认/)).toBeTruthy();
  // A failed stop with nothing else unproven must not invent an unproven-command count.
  expect(screen.queryByText(/条命令的终止无法确认；/)).toBeNull();
  expect(screen.queryByText(/停止结果未知/)).toBeNull();
  expect(
    (screen.getByRole("button", { name: "重新请求停止普通命令" }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

it("names the node's own unsignalled process groups as well as the unproven earlier commands", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        nodeOnline: true,
        pausedReason: "manual",
        stop: {
          state: "failed",
          receipt: {
            reason: "process_stop_unconfirmed",
            stopped: false,
            unconfirmedOperationIds: ["22222222-2222-4222-8222-222222222222"],
            scope: "this_node_run",
          },
          scope: "this_node_run",
          unconfirmedOperationIds: [
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
          ],
        },
        nextBefore: null,
        events: [],
      }),
    })),
  );
  const user = userEvent.setup();
  render(createElement(AgentActivity, { agentId: "agent-1" }));
  await user.click(screen.getByRole("button", { name: "查看动态" }));
  expect(
    await screen.findByText(
      "本次节点运行中仍有 2 条命令的终止无法确认；请查看动态中的收据与节点诊断后重试。",
    ),
  ).toBeTruthy();
});

it("says a confirmed one-node-run stop while an earlier command stays unknown", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        nodeOnline: true,
        pausedReason: "manual",
        stop: {
          state: "succeeded",
          receipt: { stopped: true, operationIds: [], scope: "this_node_run" },
          scope: "this_node_run",
          unconfirmedOperationIds: ["11111111-1111-4111-8111-111111111111"],
        },
        nextBefore: null,
        events: [],
      }),
    })),
  );
  const user = userEvent.setup();
  render(createElement(AgentActivity, { agentId: "agent-1" }));
  await user.click(screen.getByRole("button", { name: "查看动态" }));
  expect(
    await screen.findByText("本次节点运行中可确认的普通命令已停止；另有 1 条命令的终止无法确认。"),
  ).toBeTruthy();
  expect(screen.queryByText(/后台进程/)).toBeNull();
});

it("claims only this node run when the stop's scope is narrower than the Agent", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        nodeOnline: true,
        pausedReason: "manual",
        stop: {
          state: "succeeded",
          receipt: { stopped: true, operationIds: [], scope: "this_node_run" },
          scope: "this_node_run",
          unconfirmedOperationIds: [],
        },
        nextBefore: null,
        events: [],
      }),
    })),
  );
  const user = userEvent.setup();
  render(createElement(AgentActivity, { agentId: "agent-1" }));
  await user.click(screen.getByRole("button", { name: "查看动态" }));
  expect(await screen.findByText("本次节点运行启动的普通命令已确认停止。")).toBeTruthy();
  expect(screen.queryByText("后台进程已确认停止")).toBeNull();
});
