// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsPage } from "../src/agents-page.js";

vi.mock("../src/agents-page.css", () => ({}));
vi.mock("../src/navigation.js", () => ({ redirectToLogin: vi.fn() }));

const nodeId = "c5342142-9cf5-4b22-86f3-bdc46bb471f2";
const channelId = "c2ec7538-cbd6-4c37-9022-9405d031eb9f";
const sessionId = "d3db0e77-1761-4426-9a56-e65e67f400be";

function json(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}

let agents: Array<Record<string, unknown>>;
let posts: Array<Record<string, unknown>>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  agents = [];
  posts = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/owner/nodes")
      return json(200, { nodes: [{ id: nodeId, online: true, lastConnectedAt: null }] });
    if (url === "/api/owner/channels")
      return json(200, { channels: [{ id: channelId, name: "Research", archived: false }] });
    if (url === "/api/owner/agents") {
      if (init?.method === "POST") {
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(request);
        const first = {
          id: request.id,
          nodeId,
          name: request.name,
          role: request.role,
          description: request.description,
          model: request.model,
          initialChannelId: request.initialChannelId,
          sessionId,
          status: "failed",
          stage: "failed",
          error: "节点需要 root 权限才能创建 Linux 账号。",
          linuxIdentity: null,
          createdAt: 1,
          updatedAt: 2,
        };
        const complete = {
          ...first,
          status: "waiting_credentials",
          stage: "complete",
          error: null,
          linuxIdentity: {
            username: "mate_2ec7538cbd6c437a37a29405",
            uid: 23001,
            gid: 23001,
            home: `/var/lib/mate/agents/${String(request.id)}`,
          },
        };
        agents = [posts.length === 1 ? first : complete];
        return posts.length === 1
          ? json(502, { error: first.error, agent: first })
          : json(200, { agent: complete });
      }
      return json(200, { agents });
    }
    return json(404, { error: "missing fixture route" });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("creates a stable request and retries the same Linux identity without exposing API key settings", async () => {
  const user = userEvent.setup();
  render(createElement(AgentsPage));
  await screen.findByText(/节点会创建独立的 Linux 账号和私人 home/);
  await waitFor(() =>
    expect((screen.getByRole("combobox", { name: "Linux 节点" }) as HTMLSelectElement).value).toBe(
      nodeId,
    ),
  );

  await user.type(screen.getByRole("textbox", { name: "名称" }), "Research partner");
  await user.type(screen.getByRole("textbox", { name: "角色" }), "Researches questions");
  await user.type(screen.getByRole("textbox", { name: "介绍" }), "A private colleague.");
  await user.type(screen.getByRole("textbox", { name: "模型 ID" }), "gpt-4.1");
  await user.selectOptions(screen.getByRole("combobox", { name: "初始频道（可选）" }), channelId);
  expect(screen.queryByLabelText(/API key|凭据 key/i)).toBeNull();
  await user.click(screen.getByRole("button", { name: "创建 Agent" }));

  await screen.findByText("节点需要 root 权限才能创建 Linux 账号。");
  const retry = await screen.findByRole("button", { name: "按同一请求重试" });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    nodeId,
    name: "Research partner",
    role: "Researches questions",
    model: { provider: "openai", id: "gpt-4.1" },
    initialChannelId: channelId,
  });
  expect(posts[0]).not.toHaveProperty("apiKeyEnv");

  await user.click(retry);
  await screen.findByText(/配置模型凭据前不会启动运行；邀请频道中的消息会排队/);
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(screen.getByText("等待凭据")).toBeTruthy();
  expect(screen.getByText(/身份、home 与会话已验证/)).toBeTruthy();
});
