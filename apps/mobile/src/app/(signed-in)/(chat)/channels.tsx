import { router, Stack, useLocalSearchParams } from "expo-router";
import { conversationLabel } from "../../../chat";
import { useChatState } from "../../../session";
import { Empty, Screen } from "../../../ui";
import { ConversationRow } from "../../../conversation-row";
export default function Channels() {
  const state = useChatState();
  const archived = useLocalSearchParams<{ archived?: string }>().archived === "1";
  const rows = state.conversations.filter((x) => x.kind !== "dm" && x.archived === archived);
  return (
    <Screen grouped={false}>
      <Stack.Screen options={{ title: archived ? "已归档" : "浏览频道" }} />
      {rows.map((x) => (
        <ConversationRow
          key={x.conversationId}
          title={conversationLabel(x, state.accounts, state.me)}
          subtitle={
            x.archived
              ? "已归档 · 只读"
              : `${x.kind === "private" ? "私有" : "公开"} · ${x.member ? "已加入" : "尚未加入"}`
          }
          kind={x.kind === "dm" ? "human" : x.kind}
          onPress={() =>
            router.push({ pathname: "/conversation", params: { id: x.conversationId } })
          }
        />
      ))}
      {!rows.length && <Empty title={archived ? "没有已归档频道" : "还没有频道"} />}
    </Screen>
  );
}
