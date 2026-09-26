// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ApprovalCard } from "../src/approval-card.js";

it("shows every argument on a narrow screen before offering an approval decision", () => {
  const decide = vi.fn();
  render(
    <ApprovalCard
      approval={{
        requestId: "request-1",
        operationId: "operation-1",
        agentId: "agent-1",
        nodeId: "node-1",
        channelId: "channel-1",
        program: "/usr/bin/apt-get",
        args: ["install", "very-long-package-name"],
        cwd: "/tmp",
        expiresAt: Date.now() + 600_000,
        createdAt: Date.now(),
        state: "pending",
        receipt: null,
        nodeOnline: true,
        nodeLastConnectedAt: null,
      }}
      agentName="助手甲"
      onDecision={decide}
    />,
  );
  expect(screen.queryByRole("button", { name: "批准执行" })).toBeNull();
  fireEvent.click(screen.getByText("展开完整命令"));
  expect(screen.getByText("/usr/bin/apt-get")).toBeTruthy();
  expect(screen.getByText("very-long-package-name")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "批准执行" }));
  expect(decide).toHaveBeenCalledWith("request-1", "approve");
});

it("shows an approved request waiting for an offline node, then updates on reconnect and expiry", () => {
  const approval = {
    requestId: "request-2",
    operationId: "operation-2",
    agentId: "agent-1",
    nodeId: "node-1",
    channelId: "channel-1",
    program: "/usr/bin/id",
    args: ["-u"],
    cwd: "/tmp",
    expiresAt: Date.now() + 600_000,
    createdAt: Date.now(),
    state: "approved" as const,
    receipt: null,
    nodeOnline: false,
    nodeLastConnectedAt: null,
  };
  const card = render(<ApprovalCard approval={approval} agentName="助手甲" onDecision={vi.fn()} />);
  expect(screen.getByText("已批准，等待节点")).toBeTruthy();
  expect(screen.getByText("节点离线，尚无连接记录")).toBeTruthy();
  card.rerender(
    <ApprovalCard
      approval={{ ...approval, nodeOnline: true }}
      agentName="助手甲"
      onDecision={vi.fn()}
    />,
  );
  expect(screen.getByText("已批准，等待执行")).toBeTruthy();
  card.rerender(
    <ApprovalCard
      approval={{ ...approval, state: "expired", nodeOnline: false }}
      agentName="助手甲"
      onDecision={vi.fn()}
    />,
  );
  expect(screen.getByText("已过期，未执行")).toBeTruthy();
});
