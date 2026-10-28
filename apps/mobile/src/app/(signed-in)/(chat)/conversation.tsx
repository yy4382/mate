import { t, dateText, numberText } from "../../../i18n";
import { z } from "zod";
import { useHeaderHeight } from "@react-navigation/elements";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  Text,
  View,
  type FlatListProps,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Entry, TimelineRef } from "@mate/chat/contracts";
import { accountName, conversationLabel, timelineKey } from "../../../chat";
import {
  ConversationActionsContent,
  type ConversationPresentation,
  type TaskCreationPresentation,
  type TaskPresentation,
  CreateTaskContent,
  TaskActionsContent,
} from "../../../chat-actions";
import { setStringAsync } from "expo-clipboard";
import { ChatComposer } from "../../../chat-composer";
import { ChatMessage } from "../../../chat-message";
import { useChat, useChatState } from "../../../session";
import { Button, Caption, Empty, ErrorLine, Label, Row, Section, Sheet, styles } from "../../../ui";
import { useTheme } from "../../../theme";

type Message = Extract<Entry, { kind: "message" }>;
type Task = Extract<Entry, { kind: "task" }>;
type Panel =
  | { kind: "root" }
  | { kind: "conversation"; presentation: ConversationPresentation }
  | { kind: "message"; entry: Message }
  | { kind: "create-task"; entry: Message; presentation: TaskCreationPresentation }
  | { kind: "task"; task: Task; presentation: TaskPresentation };
const taskChangeKey = {
  created: "chat.task_created",
  claimed: "chat.task_claimed",
  yielded: "chat.task_yielded",
  transferred: "chat.task_transferred",
  completed: "chat.task_completed",
} as const;
export default function ConversationScreen() {
  const headerHeight = useHeaderHeight();
  const params = useLocalSearchParams<{
    id: string;
    thread?: string;
    seq?: string;
    sourceAgent?: string;
  }>();
  const sourceAgent = z.uuid().safeParse(params.sourceAgent);
  const agentReturn = sourceAgent.success && !params.thread ? sourceAgent.data : null;
  const id = Number(params.id);
  const seq = params.seq ? Number(params.seq) : null;
  const thread = params.thread ? Number(params.thread) : null;
  const chat = useChat();
  const state = useChatState();
  const ready =
    state.me > 0 &&
    (state.connection === "live" ||
      state.connection === "connecting" ||
      state.connection === "reconnecting");
  const c = useTheme();
  const ref: TimelineRef = thread === null ? { conversation: id } : { thread };
  const key = timelineKey(ref);
  const listKey = `${key}/${seq ?? "latest"}`;
  const activeList = useRef(listKey);
  activeList.current = listKey;
  const timeline = chat.timeline(ref);
  const draft = chat.draft(ref);
  const conversation = state.conversations.find((x) => x.conversationId === id);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [bottom, setBottom] = useState(true);
  const [readError, setReadError] = useState("");
  const [rootError, setRootError] = useState("");
  const [panel, setPanel] = useState<Panel | null>(null);
  const messageMenu = panel?.kind === "message" ? panel.entry : null;
  const task = panel?.kind === "task" ? panel.task : null;
  const sourceLocate = useRef<AbortController | null>(null);
  useEffect(() => () => sourceLocate.current?.abort(), [key, focused, task?.taskId]);
  const [copiedMessage, setCopiedMessage] = useState<number | null>(null);
  const [destination, setDestination] = useState<
    "loading" | "positioning" | "done" | "missing" | "failed"
  >(seq === null ? "done" : "loading");
  const [destinationRetry, setDestinationRetry] = useState(0);
  const jump = useRef<{
    seq: number;
    attempts: number;
    measured: number;
    positioned: boolean;
  } | null>(null);
  const measuredEntries = useRef({ key: listKey, entries: new Set<number>() });
  if (measuredEntries.current.key !== listKey)
    measuredEntries.current = { key: listKey, entries: new Set<number>() };
  const frame = useRef<number | null>(null);
  const list = useRef<FlatList<Entry>>(null);
  const marked = useRef("");
  const initial = useRef(true);
  const entries = timeline.entries;
  const currentEntries = useRef(entries);
  currentEntries.current = entries;
  const position = useCallback(() => {
    const target = jump.current;
    if (!target) return;
    const index = [...currentEntries.current].reverse().findIndex((e) => e.seq === target.seq);
    if (index < 0) return;
    if (++target.attempts > 12) {
      jump.current = null;
      setDestination("failed");
      return;
    }
    target.positioned = measuredEntries.current.entries.has(target.seq);
    list.current?.scrollToIndex({ index, viewPosition: 1, animated: false });
  }, []);
  const schedulePosition = useCallback(() => {
    if (frame.current !== null || !jump.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      position();
    });
  }, [position]);
  const visibleEntries = useRef({ key: listKey, entries: new Set<number>() });
  const viewable = useMemo<NonNullable<FlatListProps<Entry>["onViewableItemsChanged"]>>(
    () =>
      ({ viewableItems }) => {
        if (activeList.current !== listKey) return;
        visibleEntries.current = {
          key: listKey,
          entries: new Set(
            viewableItems.filter((item) => item.isViewable).map((item) => item.item.seq),
          ),
        };
        if (!jump.current) return;
        if (
          jump.current.positioned &&
          viewableItems.some((item) => item.isViewable && item.item.seq === jump.current?.seq)
        ) {
          jump.current = null;
          setDestination("done");
        } else schedulePosition();
      },
    [listKey, schedulePosition],
  );
  const newest = entries.at(-1)?.seq ?? 0;
  const count = state.unread.timelines.find((t) => timelineKey(t.timeline) === key)?.unread ?? 0;
  const canWrite = !!conversation?.member && !conversation.archived;
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, [chat, id, thread]),
  );
  useEffect(() => {
    initial.current = seq === null;
    setBottom(seq === null);
    marked.current = "";
    setReadError("");
  }, [key, seq]);
  useEffect(() => {
    if (focused && !timeline.loaded && !timeline.loading && !timeline.error && ready)
      void chat.load(ref);
  }, [focused, timeline.loaded, timeline.loading, timeline.error, ready, key, chat]);
  useEffect(() => {
    if (
      !ready ||
      !focused ||
      !bottom ||
      destination !== "done" ||
      count === 0 ||
      !timeline.loaded ||
      AppState.currentState !== "active"
    )
      return;
    const mark = `${key}/${newest}/${count}`;
    if (marked.current === mark) return;
    marked.current = mark;
    void chat.markRead(ref).then(
      () => {
        if (activeList.current === listKey) setReadError("");
      },
      () => {
        if (activeList.current !== listKey) return;
        marked.current = "";
        setReadError(t("chat.read_status_is_not_synced_tap_to"));
      },
    );
  }, [focused, bottom, count, newest, key, timeline.loaded, ready, destination]);
  const root =
    thread === null
      ? undefined
      : chat
          .timeline({ conversation: id })
          .entries.find(
            (e): e is Extract<Entry, { kind: "message" }> =>
              e.kind === "message" && e.messageId === thread,
          );
  useEffect(() => {
    if (seq === null) {
      setDestination("done");
      return;
    }
    if (!Number.isSafeInteger(seq) || seq < 1) {
      setDestination("missing");
      return;
    }
    if (!focused || !ready) return;
    if (timeline.error) {
      setDestination("failed");
      return;
    }
    if (!timeline.loaded) return;
    const cancel = new AbortController();
    setDestination("loading");
    setBottom(false);
    void chat.locate(ref, { seq }, cancel.signal).then((result) => {
      if (cancel.signal.aborted) return;
      if (result === "found") {
        jump.current = { seq, attempts: 0, measured: -1, positioned: false };
        setDestination("positioning");
        schedulePosition();
      } else if (result !== "cancelled")
        setDestination(result === "missing" ? "missing" : "failed");
    });
    return () => {
      cancel.abort();
      jump.current = null;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [
    chat,
    key,
    seq,
    focused,
    timeline.loaded,
    timeline.error,
    ready,
    destinationRetry,
    schedulePosition,
  ]);
  useEffect(() => {
    if (thread === null || !focused || !ready) return;
    const cancel = new AbortController();
    setRootError("");
    void chat.locate({ conversation: id }, { messageId: thread }, cancel.signal).then((result) => {
      if (!cancel.signal.aborted && result !== "found" && result !== "cancelled")
        setRootError(
          result === "failed"
            ? t("chat.could_not_load_the_root_message_retry")
            : t("chat.the_root_message_is_no_longer_available"),
        );
    });
    return () => cancel.abort();
  }, [chat, id, thread, focused, ready, destinationRetry]);
  const tasks = new Map<number, Extract<Entry, { kind: "task" }>>();
  for (const entry of entries) if (entry.kind === "task") tasks.set(entry.taskId, entry);
  const visibleTasks = Array.from(tasks.values());
  const taskSource = task
    ? entries.find((e): e is Message => e.kind === "message" && e.messageId === task.messageId)
    : undefined;
  function message(entry: Message, isRoot = false) {
    const knownReplies =
      thread === null &&
      (state.unread.timelines.some(
        (t) => "thread" in t.timeline && t.timeline.thread === entry.messageId,
      ) ||
        chat.timeline({ thread: entry.messageId }).entries.some((e) => e.kind === "message"));
    return (
      <ChatMessage
        entry={entry}
        accounts={state.accounts}
        me={state.me}
        related={visibleTasks.filter((t) => t.messageId === entry.messageId)}
        targetSeq={seq}
        isRoot={isRoot}
        knownReplies={knownReplies}
        onMenu={(entry) => {
          setCopiedMessage(null);
          setPanel({ kind: "message", entry });
        }}
        onTask={(task) =>
          setPanel({ kind: "task", task, presentation: { transfer: false, to: null, query: "" } })
        }
        onThread={(entry) =>
          router.push({ pathname: "/conversation", params: { id, thread: entry.messageId } })
        }
      />
    );
  }

  if (!conversation)
    return (
      <Empty
        title={state.me ? t("chat.conversation_not_found") : t("chat.loading_conversation")}
        message={state.me ? t("chat.it_may_no_longer_be_available_return") : ""}
      >
        <Button title={t("chat.back_to_chat")} onPress={() => router.replace("/chat")} />
      </Empty>
    );
  return (
    <SafeAreaView edges={["bottom", "left", "right"]} style={styles.fill}>
      <Stack.Screen
        options={{
          headerBackVisible: agentReturn === null,
          gestureEnabled: agentReturn === null,
          headerTransparent: false,
          headerStyle: { backgroundColor: c.background },
          title:
            thread === null
              ? conversationLabel(conversation, state.accounts, state.me)
              : t("chat.thread"),
        }}
      />
      {agentReturn !== null && (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button
            icon="chevron.left"
            accessibilityLabel={t("chat.back_to_agent_overview")}
            onPress={() => {
              if (router.canDismiss()) router.dismiss();
              router.navigate({ pathname: "/agents/[id]", params: { id: agentReturn } });
            }}
          >
            {t("chat.agent")}
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
      )}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="ellipsis"
          accessibilityLabel={t("chat.more")}
          onPress={() =>
            setPanel({
              kind: "conversation",
              presentation: { page: "info", query: "", invitee: null },
            })
          }
        >
          {t("chat.more")}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior="padding"
        keyboardVerticalOffset={headerHeight}
      >
        {thread !== null && (
          <View
            style={{
              backgroundColor: c.subtle,
              paddingHorizontal: 20,
              paddingVertical: 10,
              gap: 4,
            }}
          >
            {root ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("chat.view_original_post")}
                onPress={() => setPanel({ kind: "root" })}
                style={{ minHeight: 44, justifyContent: "center", gap: 4 }}
              >
                <Caption>
                  {conversationLabel(conversation, state.accounts, state.me)} ·{" "}
                  {t("chat.original_post_by", { name: accountName(state.accounts, root.author) })}
                </Caption>
                <Text numberOfLines={2} style={{ fontSize: 16, color: c.foreground }}>
                  {root.body.split("\n")[0]}
                </Text>
                <Caption accent>{t("chat.view_original_post")}</Caption>
              </Pressable>
            ) : (
              <Caption>{rootError || t("chat.loading_original_post")}</Caption>
            )}
            {rootError && (
              <Button
                title={t("chat.retry_root_message")}
                onPress={() =>
                  void chat.retryLoad({ conversation: id }).then(() => {
                    if (activeList.current === listKey) setDestinationRetry((x) => x + 1);
                  })
                }
              />
            )}
          </View>
        )}
        {seq !== null && destination !== "done" && (
          <View style={{ padding: 12 }}>
            <Label>
              {destination === "missing"
                ? t("chat.this_message_is_unavailable_or_not_in")
                : destination === "failed"
                  ? t("chat.could_not_locate_the_message_retry")
                  : t("chat.locating_message")}
            </Label>
            {(destination === "failed" || destination === "missing") && (
              <Button
                title={t("chat.retry_locating_message")}
                onPress={() =>
                  void chat.retryLoad(ref).then(() => {
                    if (activeList.current === listKey) setDestinationRetry((x) => x + 1);
                  })
                }
              />
            )}
            <Button
              title={t("chat.view_latest_messages")}
              onPress={() => router.setParams({ seq: undefined })}
            />
          </View>
        )}
        <FlatList
          key={listKey}
          ref={list}
          data={[...entries].reverse()}
          inverted
          onLayout={schedulePosition}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          maintainVisibleContentPosition={
            destination === "done"
              ? { minIndexForVisible: 0, ...(seq === null ? { autoscrollToTopThreshold: 80 } : {}) }
              : undefined
          }
          viewabilityConfig={{ viewAreaCoveragePercentThreshold: 30 }}
          onViewableItemsChanged={viewable}
          onScrollToIndexFailed={({ index, averageItemLength, highestMeasuredFrameIndex }) => {
            if (activeList.current !== listKey) return;
            const target = jump.current;
            if (target) target.positioned = false;
            if (target && highestMeasuredFrameIndex > target.measured) {
              target.measured = highestMeasuredFrameIndex;
              target.attempts = 0;
            }
            list.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
          }}
          keyExtractor={(entry) => String(entry.seq)}
          onScroll={(event) => {
            if (activeList.current !== listKey) return;
            setBottom(event.nativeEvent.contentOffset.y < 80);
            const target = jump.current;
            if (target?.positioned && visibleEntries.current.entries.has(target.seq)) {
              jump.current = null;
              setDestination("done");
            }
          }}
          scrollEventThrottle={100}
          onContentSizeChange={() => {
            if (activeList.current !== listKey) return;
            if (initial.current && entries.length) {
              list.current?.scrollToOffset({ offset: 0, animated: false });
              initial.current = false;
            }
            schedulePosition();
          }}
          renderItem={({ item, index }) => {
            const previous = entries[entries.length - index - 2];
            return (
              <View
                onLayout={() => {
                  if (activeList.current !== listKey) return;
                  measuredEntries.current.entries.add(item.seq);
                  if (jump.current?.seq === item.seq) {
                    jump.current.positioned = false;
                    schedulePosition();
                  }
                }}
              >
                {(!previous ||
                  new Date(previous.at).toDateString() !== new Date(item.at).toDateString()) && (
                  <View style={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: 4 }}>
                    <Caption>
                      {dateText(item.at, {
                        month: "long",
                        day: "numeric",
                      })}
                    </Caption>
                  </View>
                )}
                {item.kind === "message" ? (
                  message(item)
                ) : (
                  <Pressable
                    testID={`entry-${item.seq}`}
                    accessibilityRole="button"
                    accessibilityLabel={t("chat.view_named_task", { title: item.title })}
                    onPress={() =>
                      setPanel({
                        kind: "task",
                        task: tasks.get(item.taskId) ?? item,
                        presentation: { transfer: false, to: null, query: "" },
                      })
                    }
                    style={{
                      paddingHorizontal: 20,
                      paddingVertical: 12,
                      gap: 6,
                      backgroundColor: item.seq === seq ? c.tint : c.subtle,
                    }}
                  >
                    {item.seq === seq && (
                      <Caption accent>
                        {t("chat.located_message", { seq: numberText(seq ?? 0) })}
                      </Caption>
                    )}
                    <Caption>
                      {t(taskChangeKey[item.change], {
                        name: accountName(state.accounts, item.actor),
                        title: item.title,
                      })}
                    </Caption>
                  </Pressable>
                )}
              </View>
            );
          }}
          ListEmptyComponent={
            <View style={styles.page}>
              <Label>
                {timeline.loading
                  ? t("chat.loading")
                  : timeline.error
                    ? t("chat.could_not_load_messages")
                    : t("chat.no_messages_yet_say_something_below")}
              </Label>
            </View>
          }
          ListHeaderComponent={
            state.connection !== "live" ? (
              <View style={{ padding: 12, backgroundColor: c.subtle }}>
                <Label muted>
                  {state.connection === "loading"
                    ? t("chat.connecting")
                    : state.connection === "connecting"
                      ? t("chat.connecting_to_live_messages")
                      : t("chat.disconnected_reconnecting_automatically_your_draft_is_kept")}
                </Label>
              </View>
            ) : undefined
          }
          ListFooterComponent={
            <View>
              {timeline.error ? (
                <View style={styles.page}>
                  <ErrorLine text={timeline.error} />
                  <Button
                    title={t("chat.retry_loading")}
                    onPress={() => void chat.retryLoad(ref, timeline.loaded)}
                  />
                </View>
              ) : null}
              {entries[0] && !timeline.exhausted && (
                <View style={{ padding: 12 }}>
                  <Button
                    title={timeline.loading ? t("chat.loading") : t("chat.load_earlier_messages")}
                    disabled={timeline.loading}
                    onPress={() => void chat.load(ref, true)}
                  />
                </View>
              )}
            </View>
          }
        />
        {readError ? (
          <View style={{ paddingHorizontal: 16 }}>
            <Button
              title={readError}
              onPress={() =>
                void chat.markRead(ref).then(
                  () => {
                    if (activeList.current === listKey) setReadError("");
                  },
                  () => {
                    if (activeList.current === listKey)
                      setReadError(t("chat.read_status_is_not_synced_tap_to"));
                  },
                )
              }
            />
          </View>
        ) : null}
        {!composing &&
          (seq !== null
            ? destination !== "missing" && destination !== "failed"
            : !bottom && destination === "done") && (
            <Button
              title={count ? t("chat.unread_latest", { count }) : t("chat.back_to_latest_messages")}
              onPress={() => {
                if (seq !== null) router.setParams({ seq: undefined });
                else {
                  list.current?.scrollToOffset({ offset: 0, animated: false });
                  setBottom(true);
                }
              }}
            />
          )}
        {canWrite ? (
          <ChatComposer
            draft={draft}
            accounts={state.accounts}
            destination={
              thread !== null
                ? t("chat.reply_placeholder", {
                    name: conversationLabel(conversation, state.accounts, state.me),
                  })
                : conversation.kind === "dm"
                  ? t("chat.dm_placeholder", {
                      name: conversationLabel(conversation, state.accounts, state.me),
                    })
                  : t("chat.channel_placeholder", {
                      name: conversationLabel(conversation, state.accounts, state.me),
                    })
            }
            onEdit={(text) => chat.edit(ref, text)}
            onSend={() => void chat.send(ref)}
            onAbandon={() => chat.abandon(ref)}
            onFocusChange={setComposing}
          />
        ) : (
          <View style={styles.page}>
            <Label>
              {conversation.archived
                ? t("chat.this_channel_is_archived_and_can_only")
                : conversation.kind === "dm"
                  ? t("chat.this_direct_message_can_only_be_read")
                  : t("chat.you_have_not_joined_this_conversation_join")}
            </Label>
            {conversation.kind !== "dm" && !conversation.archived && (
              <Button
                title={t("chat.join_channel")}
                onPress={() =>
                  setPanel({
                    kind: "conversation",
                    presentation: { page: "info", query: "", invitee: null },
                  })
                }
              />
            )}
          </View>
        )}
      </KeyboardAvoidingView>
      <Sheet
        visible={panel !== null}
        title={
          panel?.kind === "conversation"
            ? t("chat.conversation_and_members")
            : panel?.kind === "root"
              ? t("chat.original_post")
              : panel?.kind === "create-task"
                ? t("chat.make_a_task")
                : panel?.kind === "task"
                  ? t("chat.message_tasks")
                  : t("chat.message")
        }
        onClose={() => {
          sourceLocate.current?.abort();
          setPanel(null);
        }}
      >
        {panel?.kind === "conversation" && (
          <ConversationActionsContent
            conversation={conversation}
            presentation={panel.presentation}
            onChange={(presentation) =>
              setPanel((p) => (p?.kind === "conversation" ? { ...p, presentation } : p))
            }
            onClose={() => setPanel((p) => (p?.kind === "conversation" ? null : p))}
          />
        )}
        {messageMenu && (
          <>
            <Caption>
              {accountName(state.accounts, messageMenu.author)} · {dateText(messageMenu.at)}
            </Caption>
            <Text numberOfLines={3} style={{ fontSize: 17, color: c.foreground, lineHeight: 26 }}>
              {messageMenu.body}
            </Text>
            <Section>
              {thread === null && (
                <Row
                  title={t("chat.reply_in_thread")}
                  onPress={() => {
                    const entry = messageMenu;
                    setPanel(null);
                    router.push({
                      pathname: "/conversation",
                      params: { id, thread: entry.messageId },
                    });
                  }}
                />
              )}
              {canWrite && (
                <Row
                  title={t("chat.make_a_task")}
                  testID={`create-task-${messageMenu.messageId}`}
                  onPress={() => {
                    const saved = state.operations.get(
                      `task-create/${messageMenu.messageId}`,
                    )?.input;
                    setPanel({
                      kind: "create-task",
                      entry: messageMenu,
                      presentation: {
                        title: saved?.kind === "task-create" ? saved.title : "",
                        source: false,
                      },
                    });
                  }}
                />
              )}
              <Row
                title={
                  copiedMessage === messageMenu.messageId
                    ? t("chat.message_copied")
                    : t("chat.copy_message")
                }
                onPress={() =>
                  void setStringAsync(messageMenu.body).then(() =>
                    setCopiedMessage(messageMenu.messageId),
                  )
                }
              />
            </Section>
          </>
        )}
        {panel?.kind === "root" && root && message(root, true)}
        {panel?.kind === "create-task" && (
          <CreateTaskContent
            entry={panel.entry}
            presentation={panel.presentation}
            onChange={(presentation) =>
              setPanel((p) => (p?.kind === "create-task" ? { ...p, presentation } : p))
            }
            onClose={() =>
              setPanel((p) =>
                p?.kind === "create-task" && p.entry.messageId === panel.entry.messageId ? null : p,
              )
            }
          />
        )}
        {panel?.kind === "task" && (
          <TaskActionsContent
            task={tasks.get(panel.task.taskId) ?? panel.task}
            presentation={panel.presentation}
            onChange={(presentation) =>
              setPanel((p) => (p?.kind === "task" ? { ...p, presentation } : p))
            }
            canWrite={canWrite}
            {...(taskSource ? { source: taskSource } : {})}
            onSource={async () => {
              const sourceId = panel.task.messageId;
              sourceLocate.current?.abort();
              const cancel = new AbortController();
              sourceLocate.current = cancel;
              const result = await chat.locate(ref, { messageId: sourceId }, cancel.signal);
              if (activeList.current !== listKey || cancel.signal.aborted) return;
              const source = chat
                .timeline(ref)
                .entries.find((e) => e.kind === "message" && e.messageId === sourceId);
              if (result !== "found" || !source)
                throw new Error(
                  result === "failed"
                    ? t("chat.could_not_load_the_source_message_retry")
                    : t("chat.the_source_message_is_no_longer_available"),
                );
              setPanel(null);
              router.setParams({ seq: String(source.seq) });
            }}
            onClose={() =>
              setPanel((p) =>
                p?.kind === "task" && p.task.taskId === panel.task.taskId ? null : p,
              )
            }
          />
        )}
      </Sheet>
    </SafeAreaView>
  );
}
