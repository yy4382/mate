import { useQuery } from "@tanstack/react-query";
import { ApiError, describe, get } from "./api.ts";

export type Role = "admin" | "member";

/** A human as `/api/me` and `/api/humans` show them. */
export type HumanView = {
  accountId: number;
  handle: string;
  displayName: string;
  role: Role;
};

export type ListedHuman = HumanView & { active: boolean };

export const ROLE_LABEL: Record<Role, string> = { admin: "管理员", member: "普通人类" };

/** The pattern a handle must match: the chat app's rule for handles. */
export const HANDLE_PATTERN = "[\\p{L}\\p{N}][\\p{L}\\p{N}_.\\-]*";

const MIN_PASSWORD_BYTES = 12;
export const tooShort = (password: string) =>
  new TextEncoder().encode(password).length < MIN_PASSWORD_BYTES;

export const currentHumanKey = ["me"] as const;

/** The human at this browser: their names and role. Refetched when their account changes. */
export const useCurrentHuman = () =>
  useQuery({ queryKey: currentHumanKey, queryFn: () => get<HumanView>("/api/me") });

const REFUSALS: Record<string, string> = {
  "name-taken": "这个名字已被其他 node 使用。",
  "handle-taken": "这个 handle 已被占用。",
  "last-admin": "必须至少保留一个有效的管理员。",
  "admin-only": "需要管理员权限。",
  "wrong-password": "当前密码不对。",
  "too-many-attempts": "尝试的人太多了，请稍后再试。",
  "invalid-input": "输入不合法，请检查后重试。",
};

/** What a refused request says to the human, in plain words. */
export function refusalText(error: unknown): string {
  if (error instanceof ApiError) return REFUSALS[error.reason] ?? describe(error);
  return describe(error);
}
