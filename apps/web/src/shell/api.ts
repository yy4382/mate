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

/** Where login sends the owner back to: the page they were on. */
export function loginPath(): string {
  return `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}

export function redirectToLogin(): void {
  location.assign(loginPath());
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

/**
 * One call to the control plane. The body is always JSON with its content type; a 401 anywhere sends the owner to the
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
export const del = <T = void>(path: string) => api<T>("DELETE", path);

export function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.reason})`;
  return error instanceof Error ? error.message : String(error);
}
