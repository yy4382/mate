import { t } from "../i18n";
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
  "handle-taken": t("management.this_handle_is_already_taken"),
  "name-taken": t("management.another_node_is_using_this_name"),
  "last-admin": t("management.at_least_one_active_administrator_must_remain"),
  "admin-only": t("management.administrator_access_required"),
  "wrong-password": t("management.incorrect_current_password"),
  "too-many-attempts": t("auth.too_many_people_are_trying_try_again"),
  "invalid-input": t("management.invalid_input_check_the_name_handle_password"),
  "unknown-agent": t("management.this_agent_could_not_be_found_it"),
  "unknown-account": t("management.this_human_account_could_not_be_found"),
  "unknown-node": t("management.this_node_has_not_been_paired"),
  "no-credentials": t("management.save_this_providers_api_key_first"),
  "unknown-model": t("management.the_model_is_no_longer_in_the"),
  "unsupported-thinking-level": t("management.this_model_does_not_support_the_selected"),
  "agent-closed": t("management.the_agent_is_not_running_resume_it"),
  "unknown-assistant": t("management.this_assistant_could_not_be_found_refresh"),
  "agent-exists": t("management.this_agent_already_exists_return_to_the"),
  "creation-failed": t("management.creation_was_interrupted_retrying_continues_creating_the"),
  "inactive-account": t("management.this_account_has_been_deactivated_and_cannot"),
  "node-offline": t("management.the_node_is_offline_retry_after_it"),
  "outside-workspace": t("management.only_paths_within_the_agents_workspace_can"),
  "not-found": t("management.this_path_does_not_exist"),
  unreadable: t("management.could_not_read_this_file_or_directory"),
};

export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof ApiError)
    return error.status === 401
      ? t("auth.your_session_has_expired_sign_in_again")
      : (refusals[error.reason] ??
          t("management.server_refusal", { status: error.status, reason: error.reason }));
  if (error instanceof Error && error.name === "AbortError")
    return t("management.the_request_was_cancelled_or_timed_out");
  return t("management.could_not_complete_the_request_check_your");
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
