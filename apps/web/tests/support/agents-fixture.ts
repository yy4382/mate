// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";

import { vi } from "vitest";

class FixtureState {
  agents!: Array<Record<string, unknown>>;
  posts!: Array<Record<string, unknown>>;
  providers!: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
  credentials!: Array<{ provider: string; configured: true; updatedAt: number }>;
  credentialWrites!: Array<{ provider: string; apiKey: string }>;
  agentUpdates!: Array<{ path: string; body: Record<string, unknown> }>;
  invitationPosts!: Array<{ url: string; body: Record<string, unknown> }>;
  nodeOnline!: boolean;
  nodeLastConnectedAt!: string | null;
  postConflict!: boolean;
  workspaceFailure!: { status: number; body: unknown } | null;
  workspaceDownloadResponse!: Response | null;
  workspaceDownloadStatus!: {
    state: "started" | "succeeded" | "failed" | "cancelled";
    errorCode: string | null;
  } | null;
  workspacePages!: Array<{
    path: string;
    offset: number;
    entries: Array<{ name: string; type: string; size: number }>;
    nextOffset: number | null;
  }>;
  fetchMock!: ReturnType<typeof vi.fn>;
}
export const fixture = new FixtureState();
export const nodeId = "c5342142-9cf5-4b22-86f3-bdc46bb471f2";
export const channelId = "c2ec7538-cbd6-4c37-9022-9405d031eb9f";
export const sessionId = "d3db0e77-1761-4426-9a56-e65e67f400be";
export function json(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response;
}
export function resetFixture() {
  Reflect.deleteProperty(window, "showSaveFilePicker");
  fixture.agents = [];
  fixture.posts = [];
  fixture.providers = [
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
  fixture.credentials = [];
  fixture.credentialWrites = [];
  fixture.agentUpdates = [];
  fixture.invitationPosts = [];
  fixture.nodeOnline = true;
  fixture.nodeLastConnectedAt = null;
  fixture.postConflict = false;
  fixture.workspaceFailure = null;
  fixture.workspaceDownloadResponse = null;
  fixture.workspaceDownloadStatus = { state: "succeeded", errorCode: null };
  fixture.workspacePages = [];
  fixture.fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/owner/nodes")
      return json(200, {
        nodes: [
          { id: nodeId, online: fixture.nodeOnline, lastConnectedAt: fixture.nodeLastConnectedAt },
        ],
      });
    if (url === "/api/owner/channels")
      return json(200, { channels: [{ id: channelId, name: "Research", archived: false }] });
    if (url === "/api/owner/invitable-channels")
      return json(200, { channels: [{ id: channelId, name: "Research", archived: false }] });
    if (url === "/api/owner/model-providers") return json(200, { providers: fixture.providers });
    if (url.startsWith("/api/owner/model-credentials")) {
      if (init?.method === "PUT") {
        const match = url.match(/\/api\/owner\/model-credentials\/([^/]+)$/);
        const body = JSON.parse(String(init.body)) as { apiKey: string };
        const provider = decodeURIComponent(match?.[1] ?? "");
        fixture.credentialWrites.push({ provider, apiKey: body.apiKey });
        fixture.credentials = [
          ...fixture.credentials.filter((item) => item.provider !== provider),
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
      return json(200, { credentials: fixture.credentials });
    }
    if (url === "/api/owner/agents") {
      if (init?.method === "POST") {
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        fixture.posts.push(request);
        if (fixture.postConflict) {
          fixture.nodeOnline = false;
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
        fixture.agents = [fixture.posts.length === 1 ? first : complete];
        return fixture.posts.length === 1
          ? json(502, { error: first.error, agent: first })
          : json(200, { agent: complete });
      }
      return json(200, { agents: fixture.agents });
    }
    const downloadStatusMatch = url.match(
      /^\/api\/owner\/agents\/([^/]+)\/workspace\/downloads\/([^/]+)$/,
    );
    if (downloadStatusMatch)
      return fixture.workspaceDownloadStatus
        ? json(200, { downloadId: downloadStatusMatch[2], ...fixture.workspaceDownloadStatus })
        : json(404, { code: "download_unknown" });
    const workspaceMatch = url.match(
      /^\/api\/owner\/agents\/([^/]+)\/workspace(?:\/(stat|chunk|download))?/,
    );
    if (workspaceMatch) {
      const urlObject = new URL(url, "http://mate.test");
      if (fixture.workspaceFailure)
        return json(fixture.workspaceFailure.status, fixture.workspaceFailure.body);
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
          fixture.workspaceDownloadResponse ??
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
      const page = fixture.workspacePages.find(
        (item) =>
          item.path === (urlObject.searchParams.get("path") ?? "") && item.offset === offset,
      );
      return json(200, { entries: page?.entries ?? [], nextOffset: page?.nextOffset ?? null });
    }
    if (/^\/api\/owner\/agents\/[^/]+\/(profile|model)$/.test(url) && init?.body) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      fixture.agentUpdates.push({ path: url, body });
      fixture.agents = fixture.agents.map((agent) =>
        url.includes(String(agent.id))
          ? { ...agent, ...(url.endsWith("/profile") ? body : { model: body }) }
          : agent,
      );
      return json(200, { agent: fixture.agents[0] });
    }
    if (/^\/api\/owner\/channels\/[^/]+\/invitations$/.test(url) && init?.method === "POST") {
      fixture.invitationPosts.push({
        url,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return json(201, {
        channelId,
        agentId: String(fixture.invitationPosts[0]?.body.agentId),
        status: "joined",
      });
    }
    return json(404, { error: "missing fixture route" });
  });
  vi.stubGlobal("fetch", fixture.fetchMock);
}
export function cleanupFixture() {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
}
