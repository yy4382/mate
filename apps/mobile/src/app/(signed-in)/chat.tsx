import { router, Stack } from "expo-router";
import { ScrollView, View, Pressable, Text, RefreshControl } from "react-native";
import { conversationLabel } from "../../chat";
import { useChat, useChatState } from "../../session";
import { Button, Heading, Label, styles } from "../../ui";
import { useTheme } from "../../theme";
export default function Conversations() {
  const chat = useChat();
  const state = useChatState();
  const c = useTheme();
  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button onPress={() => router.push("/account")}>账号</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScrollView
        contentContainerStyle={styles.page}
        refreshControl={
          <RefreshControl
            refreshing={state.connection === "loading"}
            onRefresh={() => void chat.resume()}
          />
        }
      >
        <View style={{ gap: 8 }}>
          <Button title="搜索消息" onPress={() => router.push("/search")} />
          <Button title="新建会话" primary onPress={() => router.push("/new")} />
        </View>
        <Label muted>
          {state.connection === "live"
            ? `全部未读 ${state.unread.total} · 提及 ${state.unread.mentions}`
            : state.connection === "loading"
              ? "正在加载聊天…"
              : "连接已中断，正在重连…"}
        </Label>
        {state.error ? <Button title="重试连接" onPress={() => void chat.resume()} /> : null}
        {state.unread.timelines
          .filter((t) => t.inThread && t.unread > 0)
          .map((t) => (
            <Button
              key={JSON.stringify(t.timeline)}
              title={`${t.mentioned ? "提及你 · " : ""}${t.label} 的讨论串 · ${t.unread} 条未读`}
              onPress={() =>
                router.push({
                  pathname: "/conversation",
                  params: {
                    id: t.conversationId,
                    ...("thread" in t.timeline ? { thread: t.timeline.thread } : {}),
                  },
                })
              }
            />
          ))}
        {(["频道", "私信"] as const).map((kind) => (
          <View key={kind} style={{ gap: 8 }}>
            <Heading>{kind}</Heading>
            {state.conversations
              .filter((x) => (x.kind === "dm") === (kind === "私信"))
              .map((conversation) => {
                const unread = state.unread.timelines.filter(
                  (t) => t.conversationId === conversation.conversationId,
                );
                const count = unread.reduce((sum, t) => sum + t.unread, 0);
                const mention = unread.some((t) => t.mentioned);
                return (
                  <Pressable
                    key={conversation.conversationId}
                    accessibilityRole="button"
                    onPress={() =>
                      router.push({
                        pathname: "/conversation",
                        params: { id: conversation.conversationId },
                      })
                    }
                    style={({ pressed }) => ({
                      padding: 16,
                      minHeight: 64,
                      borderBottomWidth: 1,
                      borderColor: c.border,
                      backgroundColor: pressed ? c.subtle : c.background,
                      gap: 8,
                    })}
                  >
                    <Text
                      style={{
                        fontSize: 18,
                        fontWeight: count ? "600" : "400",
                        color: c.foreground,
                      }}
                    >
                      {conversation.kind === "public"
                        ? "# "
                        : conversation.kind === "private"
                          ? "私有 · "
                          : ""}
                      {conversationLabel(conversation, state.accounts, state.me)}
                    </Text>
                    <Label muted>
                      {[
                        conversation.archived
                          ? "已归档"
                          : conversation.member
                            ? "已加入"
                            : "可阅读 · 尚未加入",
                        count ? `${mention ? "@ " : ""}${count} 条未读` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </Label>
                  </Pressable>
                );
              })}
            {!state.conversations.some((x) => (x.kind === "dm") === (kind === "私信")) && (
              <Label muted>
                {kind === "私信"
                  ? "还没有私信。点「新建会话」选择一位同事。"
                  : "还没有频道。点「新建会话」创建一个。"}
              </Label>
            )}
          </View>
        ))}
      </ScrollView>
    </>
  );
}
