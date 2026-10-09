// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { agentSchema } from "../../src/features/agents/agent-responses.js";
import { WorkspaceBrowser } from "../../src/features/workspace/workspace-browser.js";

const nodeId = "c5342142-9cf5-4b22-86f3-bdc46bb471f2";
const firstId = "8bfb67a1-66ed-4d56-9052-4cc7a41c60b9";
const secondId = "8bfb67a1-66ed-4d56-9052-4cc7a41c60ba";
const agents = [firstId, secondId].map((id, index) =>
  agentSchema.parse({
    id,
    nodeId,
    name: `Colleague ${index + 1}`,
    role: "Researcher",
    description: "Synthetic fixture",
    model: { provider: "openai", id: "gpt-4.1" },
    status: "ready",
    stage: "complete",
    error: null,
    linuxIdentity: {
      username: "mate-node-account",
      uid: 23001,
      gid: 23001,
      workspace: `/var/lib/mate/agents/${id}`,
    },
  }),
);
const version = { device: "1", inode: "2", size: 5, modifiedNs: "3", changedNs: "4" };
function json(body: unknown): Response {
  return Response.json(body);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each(["directory", "Agent", "offline", "reconnection"])(
  "ignores a late directory page after switching %s",
  async (change) => {
    const { promise: pending, resolve: finish } = Promise.withResolvers<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://mate.test");
        if (url.searchParams.get("offset") === "1") return pending;
        const other = url.pathname.includes(secondId) || url.searchParams.get("path");
        return json({
          entries: other
            ? [{ name: "new.txt", type: "file", size: 1 }]
            : [{ name: "projects", type: "directory", size: 0 }],
          nextOffset: other ? null : 1,
        });
      }),
    );
    const nodes = [{ id: nodeId, online: true, lastConnectedAt: "2026-10-01T00:00:00Z" }];
    const view = render(createElement(WorkspaceBrowser, { agents, nodes }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "加载更多目录项" }));
    if (change === "directory") {
      await user.click(screen.getByRole("button", { name: /projects\// }));
      await screen.findByRole("button", { name: /new.txt/ });
    } else if (change === "Agent") {
      await user.selectOptions(screen.getByRole("combobox", { name: "选择 Agent" }), secondId);
      await screen.findByRole("button", { name: /new.txt/ });
    } else {
      view.rerender(
        createElement(WorkspaceBrowser, {
          agents,
          nodes: [
            { ...nodes[0]!, online: change !== "offline", lastConnectedAt: "2026-10-01T01:00:00Z" },
          ],
        }),
      );
    }
    await act(async () => {
      finish(
        json({ entries: [{ name: "old-tail.txt", type: "file", size: 1 }], nextOffset: null }),
      );
    });
    if (change === "offline") {
      view.rerender(createElement(WorkspaceBrowser, { agents, nodes }));
      await screen.findByRole("button", { name: /projects\// });
    }
    expect(screen.queryByRole("button", { name: /old-tail.txt/ })).toBeNull();
  },
);

it("keeps the most recently selected file when an earlier preview arrives late", async () => {
  const { promise: pending, resolve: finish } = Promise.withResolvers<Response>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://mate.test");
      if (url.pathname.endsWith("/stat"))
        return json({ type: "file", size: 5, modifiedAt: 1, version });
      if (url.pathname.endsWith("/chunk"))
        return url.searchParams.get("path") === "first.txt"
          ? pending
          : json({ offset: 0, totalBytes: 5, base64: "d29ybGQ=", version });
      return json({
        entries: ["first.txt", "second.txt"].map((name) => ({ name, type: "file", size: 5 })),
        nextOffset: null,
      });
    }),
  );
  render(createElement(WorkspaceBrowser, { agents, nodes: [{ id: nodeId, online: true }] }));
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /first.txt/ }));
  await user.click(screen.getByRole("button", { name: /second.txt/ }));
  await screen.findByText("world");
  await act(async () => {
    finish(json({ offset: 0, totalBytes: 5, base64: "aGVsbG8=", version }));
  });
  expect(screen.getByText("world")).not.toBeNull();
  expect(screen.queryByText("hello")).toBeNull();
});

it.each(["directory", "Agent", "offline", "reconnection"])(
  "ignores a late file preview after switching %s",
  async (change) => {
    const { promise: pending, resolve: finish } = Promise.withResolvers<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://mate.test");
      if (url.pathname.endsWith("/stat"))
        return json({ type: "file", size: 5, modifiedAt: 1, version });
      if (url.pathname.endsWith("/chunk")) return pending;
      return json({
        entries: [
          { name: "notes.txt", type: "file", size: 5 },
          { name: "projects", type: "directory", size: 0 },
        ],
        nextOffset: null,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const nodes = [{ id: nodeId, online: true, lastConnectedAt: "2026-10-01T00:00:00Z" }];
    const view = render(createElement(WorkspaceBrowser, { agents, nodes }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /notes.txt/ }));
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/chunk?"))).toBe(true);
    if (change === "directory")
      await user.click(screen.getByRole("button", { name: /projects\// }));
    else if (change === "Agent")
      await user.selectOptions(screen.getByRole("combobox", { name: "选择 Agent" }), secondId);
    else
      view.rerender(
        createElement(WorkspaceBrowser, {
          agents,
          nodes: [
            { ...nodes[0]!, online: change !== "offline", lastConnectedAt: "2026-10-01T01:00:00Z" },
          ],
        }),
      );
    await act(async () => {
      finish(json({ offset: 0, totalBytes: 5, base64: "aGVsbG8=", version }));
    });
    expect(screen.queryByText("hello")).toBeNull();
  },
);
