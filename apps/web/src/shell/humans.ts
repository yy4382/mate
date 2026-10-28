import type { HumanView, Role } from "@mate/control-plane/contracts";
import { t } from "../i18n.ts";
import { useQuery } from "@tanstack/react-query";
import { describe, get } from "./api.ts";

export type { HumanView, Role } from "@mate/control-plane/contracts";

export const ROLE_LABEL: Record<Role, string> = {
  admin: t("humans.administrator"),
  member: t("humans.regularHuman"),
};

/** The pattern a handle must match: the chat app's rule for handles. */
export const HANDLE_PATTERN = "[\\p{L}\\p{N}][\\p{L}\\p{N}_.\\-]*";

const MIN_PASSWORD_BYTES = 12;
export const tooShort = (password: string) =>
  new TextEncoder().encode(password).length < MIN_PASSWORD_BYTES;

export const currentHumanKey = ["me"] as const;

/** The human at this browser: their names and role. Refetched when their account changes. */
export const useCurrentHuman = () =>
  useQuery({ queryKey: currentHumanKey, queryFn: () => get<HumanView>("/api/me") });

/** What a refused request says to the human, in plain words. */
export const refusalText = describe;
