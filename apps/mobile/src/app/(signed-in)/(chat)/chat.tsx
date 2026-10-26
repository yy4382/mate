import { router, Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, ScrollView, View, RefreshControl } from "react-native";
import { conversationLabel } from "../../../chat";
import { useChat, useChatState } from "../../../session";
import { Button, Caption, Empty, Row, styles } from "../../../ui";
import { ConversationRow } from "../../../conversation-row";
export default function Conversations() {
  const chat = useChat();
  const state = useChatState();
  const [filter, setFilter] = useState<"全部" | "未读" | "提及">("全部");
  const unread = state.unread.timelines;
  const matching = (count: number, mention: boolean) =>
    filter === "全部" || (filter === "未读" ? count > 0 : mention);
  const open = (id: number, thread?: number) =>
    router.push({ pathname: "/conversation", params: { id, ...(thread ? { thread } : {}) } });
  const conversations = state.conversations.filter(
    (x) => !x.archived && (x.kind === "dm" || x.member),
  );
  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="plus"
          accessibilityLabel="新建会话"
          onPress={() => router.push("/new")}
        >
          新建会话
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.page, { paddingHorizontal: 20, gap: 16 }]}
        refreshControl={
          <RefreshControl
            refreshing={state.connection === "loading"}
            onRefresh={() => void chat.resume()}
          />
        }
      >
        <Row title="搜索消息" onPress={() => router.push("/search")} />
        {state.me === 0 ? (
          <ActivityIndicator accessibilityLabel="正在读取聊天" />
        ) : (
          <>
            <View style={styles.row}>
              {(["全部", "未读", "提及"] as const).map((f) => (
                <Button key={f} title={f} primary={filter === f} onPress={() => setFilter(f)} />
              ))}
            </View>
            {state.connection !== "live" && (
              <Caption>
                {state.connection === "connecting"
                  ? "正在连接实时消息…"
                  : "连接已中断，正在重连。已有消息仍可阅读。"}
              </Caption>
            )}
            {!!state.error && <Button title="重试连接" onPress={() => void chat.resume()} />}
            {unread.some((t) => t.inThread && t.unread > 0 && matching(t.unread, t.mentioned)) && (
              <View>
                <Caption>未读讨论串</Caption>
                {unread
                  .filter((t) => t.inThread && t.unread > 0 && matching(t.unread, t.mentioned))
                  .map((t) => {
                    const thread = "thread" in t.timeline ? t.timeline.thread : undefined;
                    const root = chat
                      .timeline({ conversation: t.conversationId })
                      .entries.find((e) => e.kind === "message" && e.messageId === thread);
                    const title =
                      root?.kind === "message"
                        ? (root.body.split("\n")[0] ?? "").replace(/^#+\s*/, "").slice(0, 60)
                        : `${t.latestSender}的回复`;
                    return (
                      <ConversationRow
                        key={JSON.stringify(t.timeline)}
                        title={title || "讨论串"}
                        subtitle={`${t.label} · 讨论串`}
                        kind="thread"
                        count={t.unread}
                        mentioned={t.mentioned}
                        onPress={() => open(t.conversationId, thread)}
                      />
                    );
                  })}
              </View>
            )}
            {(["私信", "频道"] as const).map((kind) => {
              const rows = conversations
                .filter((x) => (x.kind === "dm") === (kind === "私信"))
                .filter((x) => {
                  const u = unread.filter(
                    (t) => t.conversationId === x.conversationId && !t.inThread,
                  );
                  return matching(
                    u.reduce((s, t) => s + t.unread, 0),
                    u.some((t) => t.mentioned),
                  );
                });
              return (
                rows.length > 0 && (
                  <View key={kind}>
                    <Caption>{kind}</Caption>
                    {rows.map((x) => {
                      const u = unread.find(
                        (t) => t.conversationId === x.conversationId && !t.inThread,
                      );
                      const peer =
                        x.kind === "dm"
                          ? state.accounts.find(
                              (a) => x.members.includes(a.accountId) && a.accountId !== state.me,
                            )
                          : undefined;
                      return (
                        <ConversationRow
                          key={x.conversationId}
                          title={conversationLabel(x, state.accounts, state.me)}
                          subtitle={
                            u?.unread
                              ? `${u.latestSender} · 有未读消息`
                              : peer
                                ? `${peer.kind === "agent" ? "Agent" : "人类"} · @${peer.handle}`
                                : x.kind === "private"
                                  ? "私有频道"
                                  : "公开频道"
                          }
                          kind={peer?.kind ?? (x.kind === "dm" ? "human" : x.kind)}
                          count={u?.unread ?? 0}
                          mentioned={u?.mentioned ?? false}
                          onPress={() => open(x.conversationId)}
                        />
                      );
                    })}
                  </View>
                )
              );
            })}
            {conversations.length === 0 && (
              <Empty title="从一段对话开始" message="选择一位同事发私信，或创建一个频道。">
                <Button title="新建会话" onPress={() => router.push("/new")} />
              </Empty>
            )}
            {filter !== "全部" &&
              !unread.some((t) => matching(t.unread, t.mentioned) && t.unread > 0) && (
                <Empty title={filter === "提及" ? "没有未读提及" : "都读完了"} />
              )}
            <View>
              <Row title="浏览频道" onPress={() => router.push("/channels")} />
              <Row
                title="已归档"
                onPress={() => router.push({ pathname: "/channels", params: { archived: "1" } })}
              />
            </View>
          </>
        )}
      </ScrollView>
    </>
  );
}
