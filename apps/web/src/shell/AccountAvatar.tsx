import { useAccounts } from "./accounts.ts";
import { Avatar, type AvatarSize } from "./ui.tsx";

export function AccountAvatar({
  accountId,
  name,
  size,
}: {
  accountId?: number | undefined;
  name: string;
  size?: AvatarSize;
}) {
  const account = useAccounts().data?.find((item) => item.accountId === accountId);
  const version = account?.avatarVersion;
  return (
    <Avatar
      key={`${accountId}/${version ?? "default"}`}
      name={name}
      {...(size === undefined ? {} : { size })}
      {...(account?.kind === "agent" ? { agentAccount: account.accountId } : {})}
      src={version == null ? undefined : `/api/accounts/${accountId}/avatar?v=${version}`}
    />
  );
}
