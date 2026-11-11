import { activityText, t } from "../../../i18n";
import { router, Stack } from "expo-router";
import { ActivityIndicator, FlatList, RefreshControl, View } from "react-native";
import { inbox } from "../../../chat";
import { useChat, useChatState } from "../../../session";
import { Button, Caption, Empty, styles } from "../../../ui";
import { ConversationRow } from "../../../conversation-row";
export default function Conversations() {
  const chat = useChat();
  const state = useChatState();
  const rows = inbox(state);
  const now = Date.now();
  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel={t("chat.more")}>
          <Stack.Toolbar.MenuAction icon="number" onPress={() => router.push("/channels")}>
            {t("chat.browse_channels")}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            icon="archivebox"
            onPress={() => router.push({ pathname: "/channels", params: { archived: "1" } })}
          >
            {t("chat.archived")}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="magnifyingglass"
          accessibilityLabel={t("chat.search_messages")}
          onPress={() => router.push("/search")}
        >
          {t("chat.search_messages")}
        </Stack.Toolbar.Button>
        <Stack.Toolbar.Button
          icon="plus"
          accessibilityLabel={t("chat.new_conversation")}
          onPress={() => router.push("/new")}
        >
          {t("chat.new_conversation")}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <FlatList
        data={state.me === 0 ? [] : rows}
        keyExtractor={(row) => String(row.conversation.conversationId)}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.page, { paddingHorizontal: 20, gap: 0 }]}
        refreshControl={
          <RefreshControl
            refreshing={state.connection === "loading"}
            onRefresh={() => void chat.reconnect()}
          />
        }
        ListHeaderComponent={
          state.me !== 0 && (state.connection !== "live" || !!state.error) ? (
            <View style={{ gap: 8, paddingBottom: 8 }}>
              {state.connection !== "live" && (
                <Caption>
                  {state.connection === "connecting"
                    ? t("chat.connecting_to_live_messages")
                    : t("chat.disconnected_reconnecting_now_loaded_messages_are_still")}
                </Caption>
              )}
              {!!state.error && (
                <Button title={t("chat.retry_connection")} onPress={() => void chat.reconnect()} />
              )}
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          state.me === 0 ? (
            <ActivityIndicator accessibilityLabel={t("chat.loading_chats")} />
          ) : (
            <Empty
              title={t("chat.start_a_conversation")}
              message={t("chat.choose_a_colleague_to_message_or_create")}
            >
              <Button title={t("chat.new_conversation")} onPress={() => router.push("/new")} />
            </Empty>
          )
        }
        renderItem={({ item }) => (
          <ConversationRow
            title={item.title}
            subtitle={item.preview}
            {...(item.at === null ? {} : { time: activityText(item.at, now) })}
            kind={item.kind}
            count={item.count}
            mentioned={item.mentioned}
            onPress={() =>
              router.push({
                pathname: "/conversation",
                params: { id: item.conversation.conversationId },
              })
            }
          />
        )}
      />
    </>
  );
}
