import type { Admin, AgentEvent, AgentView } from "@mate/admin";
import { HumanView } from "@mate/auth";
import { z } from "zod";
import { createParser } from "eventsource-parser";
import type { AuthState, MobileAuth } from "../auth";

export type SignedIn = Extract<AuthState, { kind: "signed-in" }>;
type Access = { kind: "ready" | "suspended"; session: SignedIn } | { kind: "closed" };
export type AgentSettingsInput = Parameters<Admin["configureAgent"]>[1];
export type PairingToken = ReturnType<Admin["createPairingToken"]>;

type StreamFetch = (
  url: string,
  init: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
}>;
const Failure = z.object({ error: z.string(), agentId: z.string().optional() });

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly agentId?: string,
  ) {
    super(reason);
  }
}

const refusals: Record<string, string> = {
  "handle-taken": "这个 Handle 已被占用。",
  "name-taken": "这个名字已被其他 Node 使用。",
  "last-admin": "必须至少保留一个有效的管理员。",
  "admin-only": "需要管理员权限。",
  "wrong-password": "当前密码不对。",
  "too-many-attempts": "尝试的人太多了，请稍后再试。",
  "invalid-input": "输入不合法，请检查名字、Handle、密码和设置。",
  "unknown-agent": "找不到这个 Agent，它可能已被删除。",
  "unknown-account": "找不到这个人类账号。",
  "unknown-node": "这个 Node 尚未配对。",
  "no-credentials": "请先保存这家提供商的 API key。",
  "unknown-model": "模型已不在目录中，请重新选择。",
  "unsupported-thinking-level": "这个模型不支持所选思考级别。",
  "agent-closed": "Agent 没有在运行，恢复后才能观察。",
  "unknown-assistant": "找不到这个工作助手，请刷新列表。",
  "agent-exists": "这个 Agent 已存在，请返回列表查看。",
  "creation-failed": "创建中断，重试会继续创建同一个 Agent。",
  "inactive-account": "这个账号已停用，不能再次使用。",
  "node-offline": "Node 离线，连接后请重试。",
  "outside-workspace": "只能查看 Agent 工作区内的路径。",
  "not-found": "路径不存在。",
  unreadable: "无法读取这个文件或目录。",
};

export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof ApiError)
    return error.status === 401
      ? "登录已失效，请重新登录。"
      : (refusals[error.reason] ?? `服务器拒绝了操作（${error.status}，${error.reason}）。`);
  if (error instanceof Error && error.name === "AbortError") return "请求已取消或超时，请重试。";
  return "无法完成请求，请检查网络和服务器后重试。";
}

/** Requests belong to one login, never to the next human or selected server. */
export class ManagementClient {
  readonly server: string;
  private access: Access;
  private listeners = new Set<() => void>();
  getSnapshot = (): Access => this.access;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private requests = new Set<AbortController>();
  private unsubscribe: () => void;

  constructor(
    private auth: MobileAuth,
    session: SignedIn,
    private fetcher: typeof fetch,
    private streamFetch: StreamFetch,
  ) {
    this.server = session.server;
    this.access = { kind: "ready", session };
    const update = () => {
      const state = auth.getSnapshot();
      if (this.access.kind === "closed") return;
      if (
        state.kind === "signed-in" &&
        state.server === session.server &&
        state.human.accountId === session.human.accountId &&
        state.human.role === session.human.role
      ) {
        this.publish({ kind: "ready", session: state });
      } else if (
        (state.kind === "checking" || state.kind === "unavailable") &&
        state.server === session.server
      ) {
        this.abortRequests();
        this.publish({ kind: "suspended", session: this.access.session });
      } else this.close();
    };
    this.unsubscribe = auth.subscribe(update);
    update();
  }

  private publish(access: Access): void {
    this.access = access;
    this.listeners.forEach((listener) => listener());
  }

  private abortRequests(): void {
    this.requests.forEach((request) => request.abort());
    this.requests.clear();
  }

  close(): void {
    this.abortRequests();
    this.unsubscribe?.();
    this.publish({ kind: "closed" });
  }

  private check(signal?: AbortSignal): void {
    if (this.access.kind !== "ready" || signal?.aborted)
      throw new DOMException("Login unavailable or request cancelled", "AbortError");
  }

  private async refuse(
    response: { status: number; json(): Promise<unknown> },
    signal: AbortSignal,
  ): Promise<never> {
    const body = Failure.safeParse(await response.json().catch(() => ({})));
    this.check(signal);
    if (response.status === 401) void this.auth.revalidate();
    throw new ApiError(
      response.status,
      body.success ? body.data.error : "request-failed",
      body.success ? body.data.agentId : undefined,
    );
  }

  async request<T = void>(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    this.check();
    const request = new AbortController();
    const abort = () => request.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) request.abort();
    this.requests.add(request);
    const timeout = setTimeout(abort, 20_000);
    try {
      const response = await this.fetcher(this.server + path, {
        method,
        credentials: "include",
        signal: request.signal,
        ...(method === "GET"
          ? {}
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body ?? {}),
            }),
      });
      this.check(request.signal);
      if (!response.ok) return await this.refuse(response, request.signal);
      const value = response.status === 204 ? undefined : await response.json();
      this.check(request.signal);
      return value;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      this.requests.delete(request);
    }
  }

  async createAgent(
    input: Parameters<Admin["createAgent"]>[0] & { agentId: string },
  ): Promise<void> {
    try {
      await this.request("/api/admin/agents", "POST", input);
    } catch (cause) {
      if (cause instanceof ApiError && cause.reason === "agent-exists") {
        const agents = await this.request<AgentView[]>("/api/admin/agents");
        if (agents.some((agent) => agent.agentId === input.agentId)) return;
      }
      throw cause;
    }
  }

  async saveProfile(displayName: string, handle: string): Promise<HumanView> {
    const previous = this.auth.getSnapshot();
    const human = HumanView.parse(await this.request("/api/me", "PATCH", { displayName, handle }));
    this.check();
    if (previous.kind === "signed-in") this.auth.updateHuman(previous, human);
    return human;
  }

  async observe(
    agentId: string,
    assistant: string,
    signal: AbortSignal,
    receive: (events: AgentEvent[] | "ended") => void,
  ): Promise<void> {
    this.check();
    const request = new AbortController();
    const abort = () => request.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    this.requests.add(request);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const connectTimeout = setTimeout(abort, 20_000);
    let heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await this.streamFetch(
        this.server +
          `/api/admin/agents/${encodeURIComponent(agentId)}/events` +
          (assistant ? `?assistant=${encodeURIComponent(assistant)}` : ""),
        {
          credentials: "include",
          signal: request.signal,
          headers: { accept: "text/event-stream" },
        },
      );
      clearTimeout(connectTimeout);
      this.check(request.signal);
      if (!response.ok) return await this.refuse(response, request.signal);
      if (!response.body) throw new Error("No event stream");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let ended = false;
      const parser = createParser({
        onEvent: ({ event, data }) => {
          if (ended) return;
          if (event === "login") {
            ended = true;
            void this.auth.revalidate();
          } else if (event === "ended") {
            ended = true;
            receive("ended");
          } else if (event === "events") {
            const events: AgentEvent[] = JSON.parse(data);
            receive(events);
          }
        },
      });
      for (;;) {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = setTimeout(abort, 60_000);
        const { done, value } = await reader.read();
        this.check(request.signal);
        if (done) throw new Error("Event stream disconnected");
        parser.feed(decoder.decode(value, { stream: true }));
        if (ended) return;
      }
    } finally {
      clearTimeout(connectTimeout);
      clearTimeout(heartbeatTimeout);
      signal.removeEventListener("abort", abort);
      void reader?.cancel().catch(() => undefined);
      request.abort();
      this.requests.delete(request);
    }
  }
}
