import { t } from "../../../i18n";
import { router, Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, ScrollView, View, RefreshControl } from "react-native";
import { conversationLabel } from "../../../chat";
import { useChat, useChatState } from "../../../session";
import { Button, Caption, Empty, Row, Segmented, styles } from "../../../ui";
import { ConversationRow } from "../../../conversation-row";
export default function Conversations() {
  const chat = useChat();
  const state = useChatState();
  const [filter, setFilter] = useState<"all" | "unread" | "mentions">("all");
  const unread = state.unread.timelines;
  const matching = (count: number, mention: boolean) =>
    filter === "all" || (filter === "unread" ? count > 0 : mention);
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
          accessibilityLabel={t("chat.new_conversation")}
          onPress={() => router.push("/new")}
        >
          {t("chat.new_conversation")}
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
        <Row title={t("chat.search_messages")} onPress={() => router.push("/search")} />
        {state.me === 0 ? (
          <ActivityIndicator accessibilityLabel={t("chat.loading_chats")} />
        ) : (
          <>
            <Segmented
              options={["all", "unread", "mentions"] as const}
              labels={{
                all: t("chat.all"),
                unread: t("chat.unread"),
                mentions: t("chat.mentions"),
              }}
              value={filter}
              onChange={setFilter}
            />
            {state.connection !== "live" && (
              <Caption>
                {state.connection === "connecting"
                  ? t("chat.connecting_to_live_messages")
                  : t("chat.disconnected_reconnecting_now_loaded_messages_are_still")}
              </Caption>
            )}
            {!!state.error && (
              <Button title={t("chat.retry_connection")} onPress={() => void chat.resume()} />
            )}
            {unread.some(
              (unreadTimeline) =>
                unreadTimeline.inThread &&
                unreadTimeline.unread > 0 &&
                matching(unreadTimeline.unread, unreadTimeline.mentioned),
            ) && (
              <View>
                <Caption>{t("chat.unread_threads")}</Caption>
                {unread
                  .filter(
                    (unreadTimeline) =>
                      unreadTimeline.inThread &&
                      unreadTimeline.unread > 0 &&
                      matching(unreadTimeline.unread, unreadTimeline.mentioned),
                  )
                  .map((unreadTimeline) => {
                    const thread =
                      "thread" in unreadTimeline.timeline
                        ? unreadTimeline.timeline.thread
                        : undefined;
                    const root = chat
                      .timeline({ conversation: unreadTimeline.conversationId })
                      .entries.find((e) => e.kind === "message" && e.messageId === thread);
                    const title =
                      root?.kind === "message"
                        ? (root.body.split("\n")[0] ?? "").replace(/^#+\s*/, "").slice(0, 60)
                        : t("chat.reply_from", {
                            name:
                              state.accounts.find((a) => a.handle === unreadTimeline.latestSender)
                                ?.displayName ?? unreadTimeline.latestSender,
                          });
                    return (
                      <ConversationRow
                        key={JSON.stringify(unreadTimeline.timeline)}
                        title={title || t("chat.thread")}
                        subtitle={t("chat.thread_label", { name: unreadTimeline.label })}
                        kind="thread"
                        count={unreadTimeline.unread}
                        mentioned={unreadTimeline.mentioned}
                        onPress={() => open(unreadTimeline.conversationId, thread)}
                      />
                    );
                  })}
              </View>
            )}
            {(["dm", "channel"] as const).map((kind) => {
              const rows = conversations
                .filter((x) => (x.kind === "dm") === (kind === "dm"))
                .filter((x) => {
                  const u = unread.filter(
                    (unreadTimeline) =>
                      unreadTimeline.conversationId === x.conversationId &&
                      !unreadTimeline.inThread,
                  );
                  return matching(
                    u.reduce((s, unreadTimeline) => s + unreadTimeline.unread, 0),
                    u.some((unreadTimeline) => unreadTimeline.mentioned),
                  );
                });
              return (
                rows.length > 0 && (
                  <View key={kind}>
                    <Caption>
                      {kind === "dm" ? t("chat.direct_message") : t("chat.channel")}
                    </Caption>
                    {rows.map((x) => {
                      const u = unread.find(
                        (unreadTimeline) =>
                          unreadTimeline.conversationId === x.conversationId &&
                          !unreadTimeline.inThread,
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
                              ? t("chat.unread_from", {
                                  name:
                                    state.accounts.find((a) => a.handle === u.latestSender)
                                      ?.displayName ?? u.latestSender,
                                })
                              : peer
                                ? `${peer.kind === "agent" ? t("chat.agent") : t("chat.human")} · @${peer.handle}`
                                : x.kind === "private"
                                  ? t("chat.private_channel")
                                  : t("chat.public_channel")
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
              <Empty
                title={t("chat.start_a_conversation")}
                message={t("chat.choose_a_colleague_to_message_or_create")}
              >
                <Button title={t("chat.new_conversation")} onPress={() => router.push("/new")} />
              </Empty>
            )}
            {filter !== "all" &&
              !unread.some(
                (unreadTimeline) =>
                  matching(unreadTimeline.unread, unreadTimeline.mentioned) &&
                  unreadTimeline.unread > 0,
              ) && (
                <Empty
                  title={
                    filter === "mentions" ? t("chat.no_unread_mentions") : t("chat.all_caught_up")
                  }
                />
              )}
            <View>
              <Row title={t("chat.browse_channels")} onPress={() => router.push("/channels")} />
              <Row
                title={t("chat.archived")}
                onPress={() => router.push({ pathname: "/channels", params: { archived: "1" } })}
              />
            </View>
          </>
        )}
      </ScrollView>
    </>
  );
}
