import type { z } from "zod";
import { redirectToLogin } from "../../navigation.js";

export async function readJSON<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (response.status === 401) {
    redirectToLogin();
    throw new Error("登录状态已失效");
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorMessage(result, "暂时无法读取控制面资料。"));
  const parsed = schema.safeParse(result);
  if (!parsed.success) throw new Error("暂时无法读取控制面资料。");
  return parsed.data;
}

export function errorMessage(result: unknown, fallback: string): string {
  return typeof result === "object" && result !== null && "error" in result
    ? String(result.error)
    : fallback;
}
