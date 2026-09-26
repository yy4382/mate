// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentActivity } from "../src/agent-activity.js";

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
        stop: { state: "failed", receipt: { reason: "systemd_stop_failed" } },
        nextBefore: null,
        events: [],
      }),
    })),
  );
  const user = userEvent.setup();
  render(createElement(AgentActivity, { agentId: "agent-1" }));
  await user.click(screen.getByRole("button", { name: "查看动态" }));
  expect(await screen.findByText(/后台进程停止失败；请查看动态中的失败收据/)).toBeTruthy();
  expect(screen.queryByText(/停止结果未知/)).toBeNull();
  expect(
    (screen.getByRole("button", { name: "重新请求停止后台进程" }) as HTMLButtonElement).disabled,
  ).toBe(false);
});
