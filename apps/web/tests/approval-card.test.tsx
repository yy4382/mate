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
