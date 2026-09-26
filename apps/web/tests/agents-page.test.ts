// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
let providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
let credentials: Array<{ provider: string; configured: true; updatedAt: number }>;
let credentialWrites: Array<{ provider: string; apiKey: string }>;
let invitationPosts: Array<{ url: string; body: Record<string, unknown> }>;
let nodeOnline: boolean;
let postConflict: boolean;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  agents = [];
  posts = [];
  providers = [
    {
      id: "openai",
      name: "OpenAI",
      models: [
        { id: "gpt-4.1", name: "GPT-4.1" },
        { id: "gpt-4o-mini", name: "GPT-4o mini" },
      ],
    },
    {
      id: "anthropic",
      name: "Anthropic",
      models: [{ id: "claude-sonnet-4", name: "Claude Sonnet 4" }],
    },
  ];
  credentials = [];
  credentialWrites = [];
  invitationPosts = [];
  nodeOnline = true;
  postConflict = false;
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/owner/nodes")
      return json(200, { nodes: [{ id: nodeId, online: nodeOnline, lastConnectedAt: null }] });
    if (url === "/api/owner/channels")
      return json(200, { channels: [{ id: channelId, name: "Research", archived: false }] });
    if (url === "/api/owner/invitable-channels")
      return json(200, { channels: [{ id: channelId, name: "Research", archived: false }] });
    if (url === "/api/owner/model-providers") return json(200, { providers });
    if (url.startsWith("/api/owner/model-credentials")) {
      if (init?.method === "PUT") {
        const match = url.match(/\/api\/owner\/model-credentials\/([^/]+)$/);
        const body = JSON.parse(String(init.body)) as { apiKey: string };
        const provider = decodeURIComponent(match?.[1] ?? "");
        credentialWrites.push({ provider, apiKey: body.apiKey });
        credentials = [
          ...credentials.filter((item) => item.provider !== provider),
          {
            provider,
            configured: true,
            updatedAt: 3,
          },
        ];
        return {
          status: 204,
          ok: true,
          json: async () => null,
          text: async () => "",
        } as Response;
      }
      return json(200, { credentials });
    }
    if (url === "/api/owner/agents") {
      if (init?.method === "POST") {
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(request);
        if (postConflict) {
          nodeOnline = false;
          return json(409, { error: "节点已离线，Agent 资料尚未提交。" });
        }
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
    if (/^\/api\/owner\/channels\/[^/]+\/invitations$/.test(url) && init?.method === "POST") {
      invitationPosts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return json(201, {
        channelId,
        agentId: String(invitationPosts[0]?.body.agentId),
        status: "joined",
      });
    }
    return json(404, { error: "missing fixture route" });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("creates a stable request and retries the same Linux identity without putting credentials in Agent data", async () => {
  let poll: (() => void) | undefined;
  vi.spyOn(window, "setInterval").mockImplementation(((callback: TimerHandler) => {
    if (typeof callback === "function") poll = callback as () => void;
    return 1;
  }) as typeof window.setInterval);
  const user = userEvent.setup();
  render(createElement(AgentsPage));
  await screen.findByText(/节点会创建独立的 Linux 账号和私人 home/);
  await waitFor(() =>
    expect((screen.getByRole("combobox", { name: "Linux 节点" }) as HTMLSelectElement).value).toBe(
      nodeId,
    ),
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
    "节点需要 root 权限才能创建 Linux 账号。",
  );
  await act(async () => {
    poll?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "节点需要 root 权限才能创建 Linux 账号。",
  );
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

it("lets the owner invite an existing Agent to a channel from the Chinese Agent page", async () => {
  const agentId = "8bfb67a1-66ed-4d56-9052-4cc7a41c60b9";
  agents = [
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
        username: "mate_8bfb67a166ed4d5690524cc7",
        uid: 23001,
        gid: 23001,
        home: `/var/lib/mate/agents/${agentId}`,
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
  expect(invitationPosts).toEqual([
    {
      url: `/api/owner/channels/${channelId}/invitations`,
      body: { agentId },
    },
  ]);
});

it("lets the owner save one provider key without displaying it again", async () => {
  const user = userEvent.setup();
  render(createElement(AgentsPage));
  await screen.findByRole("heading", { name: "模型服务凭据" });
  await user.selectOptions(screen.getByRole("combobox", { name: "模型服务" }), "anthropic");
  const syntheticKey = "synthetic-key-used-only-in-this-test";
  await user.type(screen.getByLabelText("API key"), syntheticKey);
  await user.click(screen.getByRole("button", { name: "保存或替换 API key" }));

  await waitFor(() =>
    expect(credentialWrites).toEqual([{ provider: "anthropic", apiKey: syntheticKey }]),
  );
  await screen.findByText("已配置");
  expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
  expect(document.body.textContent?.includes(syntheticKey)).toBe(false);
  expect(screen.getByText("凭据已保存；服务列表不会显示 key。")).toBeTruthy();
});

it("keeps a no-record node conflict visible through refreshes until the owner starts a new request", async () => {
  let poll: (() => void) | undefined;
  vi.spyOn(window, "setInterval").mockImplementation(((callback: TimerHandler) => {
    if (typeof callback === "function") poll = callback as () => void;
    return 1;
  }) as typeof window.setInterval);
  const user = userEvent.setup();
  render(createElement(AgentsPage));
  await screen.findByText(/节点会创建独立的 Linux 账号和私人 home/);
  await waitFor(() =>
    expect((screen.getByRole("combobox", { name: "Linux 节点" }) as HTMLSelectElement).value).toBe(
      nodeId,
    ),
  );

  await user.type(screen.getByRole("textbox", { name: "名称" }), "Offline colleague");
  await user.type(screen.getByRole("textbox", { name: "角色" }), "Waits for the node");
  await user.selectOptions(screen.getByRole("combobox", { name: "模型" }), "gpt-4.1");
  postConflict = true;
  await user.click(screen.getByRole("button", { name: "创建 Agent" }));

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("节点已离线，Agent 资料尚未提交。");
  expect(screen.queryByText("Agent 创建失败")).toBeNull();
  expect(posts).toHaveLength(1);
  await act(async () => {
    poll?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.getByRole("alert").textContent).toBe("节点已离线，Agent 资料尚未提交。");
  expect((screen.getByRole("button", { name: "创建 Agent" }) as HTMLButtonElement).disabled).toBe(
    true,
  );

  await user.click(screen.getByRole("button", { name: "新建资料" }));
  expect(screen.queryByRole("alert")).toBeNull();
});
