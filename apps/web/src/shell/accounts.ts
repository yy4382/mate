import { useQuery, type QueryClient } from "@tanstack/react-query";
import type { AccountView } from "@mate/chat";
import { get } from "./api.ts";

export type { AccountView } from "@mate/chat";
export const accountsKey = ["accounts"] as const;

export const useAccounts = () =>
  useQuery({
    queryKey: accountsKey,
    queryFn: async () => (await get<{ accounts: AccountView[] }>("/api/chat/snapshot")).accounts,
    staleTime: Infinity,
  });

export function updateAccount(qc: QueryClient, account: AccountView): void {
  qc.setQueryData<AccountView[]>(accountsKey, (accounts) => {
    if (accounts === undefined) return accounts;
    return accounts.some((item) => item.accountId === account.accountId)
      ? accounts.map((item) => (item.accountId === account.accountId ? account : item))
      : [...accounts, account];
  });
}
