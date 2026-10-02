import type { z } from "zod";
import { redirectToLogin } from "../../navigation.js";

export async function workspaceJSON<T>(path: string, schema: z.ZodType<T>) {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (response.status === 401) {
    redirectToLogin();
    throw new Error("登录状态已失效");
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const details = typeof result === "object" && result !== null ? result : {};
    throw new WorkspaceRequestError(
      errorMessage(result, "暂时无法读取 Agent 工作区。"),
      "code" in details && typeof details.code === "string"
        ? details.code
        : "workspace_unavailable",
      "lastConnectedAt" in details && typeof details.lastConnectedAt === "string"
        ? details.lastConnectedAt
        : null,
    );
  }
  const parsed = schema.safeParse(result);
  if (!parsed.success) throw new Error("暂时无法读取 Agent 工作区。");
  return parsed.data;
}

export class WorkspaceRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly lastConnectedAt: string | null,
  ) {
    super(message);
    this.name = "WorkspaceRequestError";
  }
}

function errorMessage(result: unknown, fallback: string): string {
  return typeof result === "object" && result !== null && "error" in result
    ? String(result.error)
    : fallback;
}
