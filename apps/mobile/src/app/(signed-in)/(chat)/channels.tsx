import { t } from "../../../i18n";
import { router, Stack, useLocalSearchParams } from "expo-router";
import type { ConversationView } from "@mate/chat/contracts";
import { conversationLabel } from "../../../chat";
import { useChatState } from "../../../session";
import { Empty, Screen } from "../../../ui";
import { ConversationRow } from "../../../conversation-row";
export default function Channels() {
  const state = useChatState();
  const archived = useLocalSearchParams<{ archived?: string }>().archived === "1";
  const rows = state.conversations.filter(
    (x): x is ConversationView & { kind: "public" | "private" } =>
      x.kind !== "dm" && x.archived === archived,
  );
  return (
    <Screen grouped={false}>
      <Stack.Screen
        options={{ title: archived ? t("chat.archived") : t("chat.browse_channels") }}
      />
      {rows.map((x) => (
        <ConversationRow
          key={x.conversationId}
          title={conversationLabel(x, state.accounts, state.me)}
          subtitle={
            x.archived
              ? t("chat.archived_readonly")
              : `${x.kind === "private" ? t("chat.private") : t("chat.public")} · ${x.member ? t("chat.joined") : t("chat.not_joined")}`
          }
          kind={x.kind}
          onPress={() =>
            router.push({ pathname: "/conversation", params: { id: x.conversationId } })
          }
        />
      ))}
      {!rows.length && (
        <Empty title={archived ? t("chat.no_archived_channels") : t("chat.no_channels_yet")} />
      )}
    </Screen>
  );
}
