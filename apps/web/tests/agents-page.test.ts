// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentsPage, waitForDownloadStatus } from "../src/agents-page.js";

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
let agentUpdates: Array<{ path: string; body: Record<string, unknown> }>;
let invitationPosts: Array<{ url: string; body: Record<string, unknown> }>;
let nodeOnline: boolean;
let nodeLastConnectedAt: string | null;
let postConflict: boolean;
let workspaceFailure: { status: number; body: unknown } | null;
let workspaceDownloadResponse: Response | null;
let workspaceDownloadStatus: {
  state: "started" | "succeeded" | "failed" | "cancelled";
  errorCode: string | null;
} | null;
let workspacePages: Array<{
  path: string;
  offset: number;
  entries: Array<{ name: string; type: string; size: number }>;
  nextOffset: string | null;
}>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  Reflect.deleteProperty(window, "showSaveFilePicker");
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
  agentUpdates = [];
  invitationPosts = [];
  nodeOnline = true;
  nodeLastConnectedAt = null;
  postConflict = false;
  workspaceFailure = null;
  workspaceDownloadResponse = null;
  workspaceDownloadStatus = { state: "succeeded", errorCode: null };
  workspacePages = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/owner/nodes")
      return json(200, {
        nodes: [{ id: nodeId, online: nodeOnline, lastConnectedAt: nodeLastConnectedAt }],
      });
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
          error: "节点无法创建 Agent 工作区根路径，请检查运行账号的写入权限。",
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
            username: "mate-node-account",
            uid: 23001,
            gid: 23001,
            workspace: `/var/lib/mate/agents/${String(request.id)}`,
          },
        };
        agents = [posts.length === 1 ? first : complete];
        return posts.length === 1
          ? json(502, { error: first.error, agent: first })
          : json(200, { agent: complete });
      }
      return json(200, { agents });
    }
    const downloadStatusMatch = url.match(
      /^\/api\/owner\/agents\/([^/]+)\/workspace\/downloads\/([^/]+)$/,
    );
    if (downloadStatusMatch)
      return workspaceDownloadStatus
        ? json(200, { downloadId: downloadStatusMatch[2], ...workspaceDownloadStatus })
        : json(404, { code: "download_unknown" });
    const workspaceMatch = url.match(
      /^\/api\/owner\/agents\/([^/]+)\/workspace(?:\/(stat|chunk|download))?/,
    );
    if (workspaceMatch) {
      const urlObject = new URL(url, "http://mate.test");
      if (workspaceFailure) return json(workspaceFailure.status, workspaceFailure.body);
      if (workspaceMatch[2] === "stat")
        return json(200, {
          type: "file",
          size: 5,
          modifiedAt: 1,
          version: { device: "1", inode: "2", size: 5, modifiedNs: "3", changedNs: "4" },
        });
      if (workspaceMatch[2] === "chunk")
        return json(200, {
          offset: Number(urlObject.searchParams.get("offset") ?? 0),
          totalBytes: 5,
          base64: "aGVsbG8=",
          version: { device: "1", inode: "2", size: 5, modifiedNs: "3", changedNs: "4" },
        });
      if (workspaceMatch[2] === "download")
        return (
          workspaceDownloadResponse ??
          ({
            status: 200,
            ok: true,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("hello"));
                controller.close();
              },
            }),
            json: async () => ({}),
          } as Response)
        );
      const offset = Number(urlObject.searchParams.get("offset") ?? 0);
      const page = workspacePages.find(
        (item) =>
          item.path === (urlObject.searchParams.get("path") ?? "") && item.offset === offset,
      );
      return json(200, { entries: page?.entries ?? [], nextOffset: page?.nextOffset ?? null });
    }
    if (/^\/api\/owner\/agents\/[^/]+\/(profile|model)$/.test(url) && init?.body) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      agentUpdates.push({ path: url, body });
      agents = agents.map((agent) =>
        url.includes(String(agent.id))
          ? { ...agent, ...(url.endsWith("/profile") ? body : { model: body }) }
          : agent,
      );
      return json(200, { agent: agents[0] });
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

it("saves profile fields separately and only offers configured model services", async () => {
  agents = [
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
  credentials = [{ provider: "openai", configured: true, updatedAt: 3 }];
  render(createElement(AgentsPage));
  const user = userEvent.setup();
  const name = await screen.findByRole("textbox", { name: "Partner 名称" });
  await user.clear(name);
  await user.type(name, "Colleague");
  await user.click(screen.getByRole("button", { name: "保存名称" }));
  await waitFor(() =>
    expect(agentUpdates).toEqual([
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
  agents = [
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
      stop: { state: "failed", receipt: { reason: "systemd_stop_failed" } },
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
  expect(await screen.findByText(/后台进程停止失败；请查看动态中的失败收据/)).toBeTruthy();
  expect(screen.queryByText(/后台进程停止结果未知/)).toBeNull();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("creates a stable request and retries the same workspace request without putting credentials in Agent data", async () => {
  let poll: (() => void) | undefined;
  vi.spyOn(window, "setInterval").mockImplementation(((callback: TimerHandler) => {
    if (typeof callback === "function") poll = callback as () => void;
    return 1;
  }) as typeof window.setInterval);
  const user = userEvent.setup();
  render(createElement(AgentsPage));
  await screen.findByText(/在线节点会在运行账号下创建它的默认工作区和记忆入口/);
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
    "节点无法创建 Agent 工作区根路径，请检查运行账号的写入权限。",
  );
  await act(async () => {
    poll?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "节点无法创建 Agent 工作区根路径，请检查运行账号的写入权限。",
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
  expect(screen.getByText(/默认工作区、记忆入口与会话已验证/)).toBeTruthy();
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
        username: "mate-node-account",
        uid: 23001,
        gid: 23001,
        workspace: `/var/lib/mate/agents/${agentId}`,
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

it("browses an Agent private home read-only, previews and streams downloads, and loads every directory page", async () => {
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
      status: "ready",
      stage: "complete",
      error: null,
      linuxIdentity: {
        username: "mate-node-account",
        uid: 23001,
        gid: 23001,
        workspace: `/var/lib/mate/agents/${agentId}`,
      },
      createdAt: 1,
      updatedAt: 2,
    },
  ];
  workspacePages = [
    {
      path: "",
      offset: 0,
      entries: [
        { name: "notes.txt", type: "file", size: 5 },
        { name: "projects", type: "directory", size: 0 },
        { name: "shortcut", type: "symlink", size: 0 },
      ],
      nextOffset: "3",
    },
    {
      path: "",
      offset: 3,
      entries: [{ name: "tail.txt", type: "file", size: 1 }],
      nextOffset: null,
    },
    {
      path: "projects",
      offset: 0,
      entries: [{ name: "plan.md", type: "file", size: 5 }],
      nextOffset: null,
    },
  ];

  const user = userEvent.setup();
  render(createElement(AgentsPage));
  expect(await screen.findByRole("heading", { name: "私人工作区" })).not.toBeNull();
  expect(await screen.findByRole("button", { name: /notes.txt/ })).not.toBeNull();
  expect(screen.getByText(/符号链接，不跟随/)).not.toBeNull();
  expect(screen.queryByRole("button", { name: /上传|删除|编辑/ })).toBeNull();

  await user.click(screen.getByRole("button", { name: /notes.txt/ }));
  expect(await screen.findByText("hello")).not.toBeNull();
  const written: Uint8Array[] = [];
  vi.stubGlobal("showSaveFilePicker", undefined);
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: vi.fn(async () => ({
      createWritable: async () =>
        new WritableStream<Uint8Array>({ write: (chunk) => written.push(chunk) }),
    })),
  });
  await user.click(screen.getByRole("button", { name: "下载" }));
  expect(await screen.findByText("下载完成。")).not.toBeNull();
  expect(Buffer.concat(written.map((chunk) => Buffer.from(chunk))).toString()).toBe("hello");

  await user.click(screen.getByRole("button", { name: "加载更多目录项" }));
  expect(await screen.findByRole("button", { name: /tail.txt/ })).not.toBeNull();
  expect(fetchMock.mock.calls.some(([input]) => String(input).includes("offset=3"))).toBe(true);

  await user.click(screen.getByRole("button", { name: /projects\// }));
  expect(await screen.findByRole("button", { name: /plan.md/ })).not.toBeNull();
});

it("streams a download through a standard browser fallback and reports its terminal status", async () => {
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
  workspacePages = [
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
  workspacePages = [
    {
      path: "",
      offset: 0,
      entries: [{ name: "notes.txt", type: "file", size: 5 }],
      nextOffset: null,
    },
  ];
  workspaceDownloadStatus = { state: "started", errorCode: null };
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const view = render(createElement(AgentsPage));
  await userEvent.setup().click(await screen.findByRole("button", { name: "下载" }));
  const countStatusRequests = () =>
    fetchMock.mock.calls.filter(([input]) => String(input).includes("/workspace/downloads/"))
      .length;
  await waitFor(() => expect(countStatusRequests()).toBe(1));
  const statusCall = fetchMock.mock.calls.find(([input]) =>
    String(input).includes("/workspace/downloads/"),
  );
  const signal = (statusCall?.[1] as RequestInit).signal as AbortSignal;

  view.unmount();
  expect(signal.aborted).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(countStatusRequests()).toBe(1);
});

it("shows classified stream failures after a standard browser download starts", async () => {
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
  workspacePages = [
    {
      path: "",
      offset: 0,
      entries: [{ name: "notes.txt", type: "file", size: 5 }],
      nextOffset: null,
    },
  ];
  workspaceDownloadStatus = { state: "failed", errorCode: "file_changed" };
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(createElement(AgentsPage));
  await userEvent.setup().click(await screen.findByRole("button", { name: "下载" }));

  expect(await screen.findByText("文件在下载期间发生变化，请重新加载后重试。")).not.toBeNull();
  expect(clicked).toHaveBeenCalledOnce();
});

it("shows a Chinese error when a workspace file disappears before download", async () => {
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
  workspacePages = [
    {
      path: "",
      offset: 0,
      entries: [{ name: "notes.txt", type: "file", size: 5 }],
      nextOffset: null,
    },
  ];
  workspaceDownloadResponse = json(404, { code: "not_found", error: "文件不存在。" });
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: vi.fn(async () => ({ createWritable: async () => new WritableStream<Uint8Array>() })),
  });
  render(createElement(AgentsPage));
  await userEvent.setup().click(await screen.findByRole("button", { name: "下载" }));
  expect((await screen.findByRole("alert")).textContent).toContain("文件已不存在");
});

it("shows a distinct permission error before starting a workspace download", async () => {
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
  workspacePages = [
    {
      path: "",
      offset: 0,
      entries: [{ name: "notes.txt", type: "file", size: 5 }],
      nextOffset: null,
    },
  ];
  workspaceDownloadResponse = json(403, {
    code: "permission_denied",
    error: "Agent Linux 用户没有读取此文件的权限。",
  });
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: vi.fn(async () => ({ createWritable: async () => new WritableStream<Uint8Array>() })),
  });
  render(createElement(AgentsPage));
  await userEvent.setup().click(await screen.findByRole("button", { name: "下载" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Linux 用户无权读取");
});

it("shows a Chinese error when a workspace download stream fails after it starts", async () => {
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
  workspacePages = [
    {
      path: "",
      offset: 0,
      entries: [{ name: "notes.txt", type: "file", size: 5 }],
      nextOffset: null,
    },
  ];
  workspaceDownloadResponse = {
    status: 200,
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hel"));
        controller.error(new Error("file_changed during stream"));
      },
    }),
    json: async () => ({}),
  } as Response;
  workspaceDownloadStatus = { state: "failed", errorCode: "file_changed" };
  Object.defineProperty(window, "showSaveFilePicker", {
    configurable: true,
    value: vi.fn(async () => ({ createWritable: async () => new WritableStream<Uint8Array>() })),
  });
  render(createElement(AgentsPage));
  await userEvent.setup().click(await screen.findByRole("button", { name: "下载" }));
  expect((await screen.findByRole("alert")).textContent).toContain("文件在下载期间发生变化");
});

it("shows the last connection time when a workspace request discovers that the node went offline", async () => {
  const agentId = "8bfb67a1-66ed-4d56-9052-4cc7a41c60b9",
    lastConnectedAt = "2026-09-26T03:04:05.000Z";
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
      status: "ready",
      stage: "complete",
      error: null,
      linuxIdentity: {
        username: "mate-node-account",
        uid: 23001,
        gid: 23001,
        workspace: `/var/lib/mate/agents/${agentId}`,
      },
      createdAt: 1,
      updatedAt: 2,
    },
  ];
  workspaceFailure = {
    status: 503,
    body: {
      error: "节点当前离线，工作区暂不可用。",
      code: "node_offline",
      lastConnectedAt,
    },
  };
  render(createElement(AgentsPage));

  expect(await screen.findByRole("alert")).not.toBeNull();
  expect(screen.getByText(/节点离线，工作区暂不可用/)).not.toBeNull();
  expect(screen.getByText(/最后连接：/)).not.toBeNull();
  expect(screen.queryByRole("list", { name: "工作区目录" })).toBeNull();
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
  await screen.findByText(/在线节点会在运行账号下创建它的默认工作区和记忆入口/);
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
