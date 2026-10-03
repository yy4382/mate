// @vitest-environment jsdom
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsPage } from "../../../src/features/agents/agents-page.js";
import { waitForDownloadStatus } from "../../../src/features/workspace/download-status.js";
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

it("streams a download through a standard browser fallback and reports its terminal status", async () => {
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
  let clicked: { href: string; target: string; rel: string } | undefined;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked = { href: this.href, target: this.target, rel: this.rel };
  });
  render(createElement(AgentsPage));
  await userEvent.setup().click(await screen.findByRole("button", { name: "下载" }));

  expect(await screen.findByText("下载完成。")).not.toBeNull();
  expect(clicked).toMatchObject({
    target: "_blank",
    rel: "noopener",
    href: expect.stringContaining("format=browser"),
  });
  expect(clicked?.href).toContain("downloadId=");
});

it("backs off download status polling until a terminal result arrives", async () => {
  let now = 0;
  const delays: number[] = [],
    fetchStatus = vi
      .fn()
      .mockResolvedValueOnce(json(200, { state: "started", errorCode: null, expiresInMs: 800 }))
      .mockResolvedValueOnce(json(200, { state: "started", errorCode: null, expiresInMs: 800 }))
      .mockResolvedValueOnce(
        json(200, { state: "failed", errorCode: "file_changed", expiresInMs: 800 }),
      ),
    status = await waitForDownloadStatus("agent-1", "download-1", {
      now: () => now,
      fetchStatus: fetchStatus as unknown as typeof fetch,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
      statusTtlMs: 400,
      registrationGraceMs: 100,
    });

  expect(status).toMatchObject({ state: "failed", errorCode: "file_changed" });
  expect(delays).toEqual([250, 500]);
  expect(fetchStatus).toHaveBeenCalledTimes(3);
});

it("stops polling at the download status TTL and reports that the result cannot be confirmed", async () => {
  let now = 0;
  const delays: number[] = [],
    fetchStatus = vi.fn(async () => json(200, { state: "started", errorCode: null })),
    pending = waitForDownloadStatus("agent-1", "download-1", {
      now: () => now,
      fetchStatus: fetchStatus as unknown as typeof fetch,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
      statusTtlMs: 800,
      registrationGraceMs: 100,
    });

  await expect(pending).rejects.toThrow("下载状态已过期，无法再确认");
  expect(delays).toEqual([250, 500, 50]);
  expect(fetchStatus).toHaveBeenCalledTimes(3);
});

it("stops status polling when the owner leaves the workspace page", async () => {
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
  fixture.workspaceDownloadStatus = { state: "started", errorCode: null };
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const view = render(createElement(AgentsPage));
  await userEvent.setup().click(await screen.findByRole("button", { name: "下载" }));
  const countStatusRequests = () =>
    fixture.fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/workspace/downloads/"),
    ).length;
  await waitFor(() => expect(countStatusRequests()).toBe(1));
  const statusCall = fixture.fetchMock.mock.calls.find(([input]) =>
    String(input).includes("/workspace/downloads/"),
  );
  const signal = (statusCall?.[1] as RequestInit).signal as AbortSignal;

  view.unmount();
  expect(signal.aborted).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(countStatusRequests()).toBe(1);
});

vi.mock("../../../src/features/agents/agents-page.css", () => ({}));
vi.mock("../../../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
