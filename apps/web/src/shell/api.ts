import { t } from "../i18n.ts";
/** A refusal from the control plane: `reason` is the `error` code of its `{ error, message }` body. */
export class ApiError extends Error {
  readonly status: number;
  readonly reason: string;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.message === "string" ? body.message : String(body.error ?? status));
    this.status = status;
    this.reason = typeof body.error === "string" ? body.error : "unknown";
    this.body = body;
  }
}

/** Where login sends the human back to: the page they were on. */
export function loginPath(): string {
  return `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}

let leavingForLogin = false;

/** An ended session reaches every open request and stream at once; the page leaves once, since a second assign aborts the first navigation. */
export function redirectToLogin(): void {
  if (leavingForLogin) return;
  leavingForLogin = true;
  location.assign(loginPath());
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * One call to the control plane. The body is always JSON with its content type; a 401 anywhere sends the human to the
 * login page, which brings them back here.
 */
export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    ...(method === "GET"
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }),
  });
  if (response.status === 401 && path !== "/api/login") {
    redirectToLogin();
    return new Promise<T>(() => undefined);
  }
  const text = await response.text();
  const parsed: unknown = text === "" ? undefined : JSON.parse(text);
  if (!response.ok)
    throw new ApiError(
      response.status,
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {},
    );
  return parsed as T;
}

export const get = <T>(path: string) => api<T>("GET", path);
export const post = <T = void>(path: string, body?: unknown) => api<T>("POST", path, body);
export const put = <T = void>(path: string, body?: unknown) => api<T>("PUT", path, body);
export const patch = <T = void>(path: string, body?: unknown) => api<T>("PATCH", path, body);
export const del = <T = void>(path: string) => api<T>("DELETE", path);

export function describe(error: unknown): string {
  if (error instanceof ApiError) {
    const labels: Record<string, string> = {
      "name-taken": t("errors.name-taken"),
      "handle-taken": t("errors.handle-taken"),
      "last-admin": t("errors.last-admin"),
      "admin-only": t("errors.admin-only"),
      "wrong-password": t("errors.wrong-password"),
      "too-many-attempts": t("errors.too-many-attempts"),
      "invalid-input": t("errors.invalid-input"),
      "unknown-agent": t("errors.unknown-agent"),
      "agent-exists": t("errors.agent-exists"),
      "unknown-node": t("errors.unknown-node"),
      "unknown-provider": t("errors.unknown-provider"),
      "no-credentials": t("errors.no-credentials"),
      "unknown-model": t("errors.unknown-model"),
      "unsupported-thinking-level": t("errors.unsupported-thinking-level"),
      "agent-closed": t("errors.agent-closed"),
      "unknown-assistant": t("errors.unknown-assistant"),
      "node-offline": t("errors.node-offline"),
      "outside-workspace": t("errors.outside-workspace"),
      "not-found": t("errors.not-found"),
      unreadable: t("errors.unreadable"),
      "unknown-account": t("errors.unknown-account"),
      "inactive-account": t("errors.inactive-account"),
      "not-member": t("errors.not-member"),
      archived: t("errors.archived"),
      "invalid-target": t("errors.invalid-target"),
      "request-conflict": t("errors.request-conflict"),
      "human-only": t("errors.human-only"),
      "creation-failed": t("errors.creation-failed"),
      internal: t("errors.internal"),
      "body-too-large": t("errors.body-too-large"),
      "unsupported-media-type": t("errors.unsupported-media-type"),
      "invalid-json": t("errors.invalid-json"),
      "cross-origin": t("errors.cross-origin"),
      "login-required": t("errors.login-required"),
      "no-route": t("errors.no-route"),
      "method-not-allowed": t("errors.method-not-allowed"),
    };
    return labels[error.reason] ?? t("errors.requestFailed", { code: error.reason });
  }
  if (error instanceof TypeError) return t("errors.network");
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : t("errors.unexpected");
}

export function taskRefusal(reason: "claimed" | "not-owner" | "completed"): string {
  const labels = {
    claimed: t("taskErrors.claimed"),
    "not-owner": t("taskErrors.not-owner"),
    completed: t("taskErrors.completed"),
  };
  return labels[reason];
}
