import type { z } from "zod";
import { redirectToLogin } from "../../navigation.js";

/** A received HTTP error, distinguishable from a lost or unreadable response. */
export class OwnerRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function ownerJSON<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  init?: RequestInit,
) {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: "application/json", ...init?.headers },
  });
  if (response.status === 401) {
    redirectToLogin();
    throw new OwnerRequestError(401, "登录状态已失效");
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new OwnerRequestError(
      response.status,
      typeof result === "object" && result !== null && "error" in result
        ? String(result.error)
        : "请求失败，请重试。",
    );
  }
  const parsed = schema.safeParse(result);
  if (!parsed.success) throw new Error("服务器响应无效，请刷新页面重试。");
  return parsed.data;
}
