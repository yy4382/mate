// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { NodesPage } from "../src/nodes-page.js";
vi.mock("../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const json = (body: unknown) => ({ status: 200, ok: true, json: async () => body }) as Response;

it("shows each paired node's live connection state from the control plane", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      json({
        nodes: [
          { id: "paired-node-online", online: true, lastConnectedAt: "2026-09-27T10:00:00.000Z" },
          { id: "paired-node-offline", online: false, lastConnectedAt: null },
        ],
      }),
    ),
  );
  render(createElement(NodesPage));

  expect(await screen.findByText("paired-node-online")).not.toBeNull();
  expect(screen.getByText("在线")).not.toBeNull();
  expect(screen.getByText("paired-node-offline")).not.toBeNull();
  expect(screen.getByText("离线")).not.toBeNull();
  expect(screen.getByText("最后连接：从未连接")).not.toBeNull();
});

it("offers a one-time pairing token with a hidden-input start command", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ pairingToken: "one-time-pairing-token", expiresAt: "2026-09-27T10:10:00.000Z" })
        : json({ nodes: [] }),
    ),
  );
  render(createElement(NodesPage));

  await userEvent.setup().click(await screen.findByRole("button", { name: "创建一次性令牌" }));
  expect(await screen.findByText("one-time-pairing-token")).not.toBeNull();
  expect(screen.getByText(/read -r -s -p '配对令牌: ' MATE_NODE_PAIRING_TOKEN/)).not.toBeNull();
  expect(screen.getByText(/node dist\/src\/node\/main\.js/)).not.toBeNull();
});
