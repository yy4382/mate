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
const verbs = {
  created: "创建了任务",
  claimed: "认领了任务",
  yielded: "让出了任务",
  transferred: "转交了任务",
  completed: "完成了任务",
};
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
        setReadError("已读状态未同步，点此重试。");
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
        setRootError(result === "failed" ? "根消息加载失败，请重试。" : "根消息已不可用。");
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
        title={state.me ? "找不到这个会话" : "正在读取会话…"}
        message={state.me ? "它可能已不可用。返回聊天选择其他会话。" : ""}
      >
        <Button title="返回聊天" onPress={() => router.replace("/chat")} />
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
            thread === null ? conversationLabel(conversation, state.accounts, state.me) : "讨论串",
        }}
      />
      {agentReturn !== null && (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button
            icon="chevron.left"
            accessibilityLabel="返回 Agent 总览"
            onPress={() => {
              if (router.canDismiss()) router.dismiss();
              router.navigate({ pathname: "/agents/[id]", params: { id: agentReturn } });
            }}
          >
            Agent
          </Stack.Toolbar.Button>
        </Stack.Toolbar>
      )}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="ellipsis"
          accessibilityLabel="更多"
          onPress={() =>
            setPanel({
              kind: "conversation",
              presentation: { page: "info", query: "", invitee: null },
            })
          }
        >
          更多
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
                accessibilityLabel="查看原帖"
                onPress={() => setPanel({ kind: "root" })}
                style={{ minHeight: 44, justifyContent: "center", gap: 4 }}
              >
                <Caption>
                  {conversationLabel(conversation, state.accounts, state.me)} ·{" "}
                  {accountName(state.accounts, root.author)}的原帖
                </Caption>
                <Text numberOfLines={2} style={{ fontSize: 16, color: c.foreground }}>
                  {root.body.split("\n")[0]}
                </Text>
                <Caption accent>查看原帖</Caption>
              </Pressable>
            ) : (
              <Caption>{rootError || "正在读取原帖…"}</Caption>
            )}
            {rootError && (
              <Button
                title="重试根消息"
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
                ? "这条消息已不可用，或不在当前时间线中。"
                : destination === "failed"
                  ? "消息定位失败，请重试。"
                  : "正在定位消息…"}
            </Label>
            {(destination === "failed" || destination === "missing") && (
              <Button
                title="重试定位消息"
                onPress={() =>
                  void chat.retryLoad(ref).then(() => {
                    if (activeList.current === listKey) setDestinationRetry((x) => x + 1);
                  })
                }
              />
            )}
            <Button title="查看最新消息" onPress={() => router.setParams({ seq: undefined })} />
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
                      {new Date(item.at).toLocaleDateString("zh-CN", {
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
                    accessibilityLabel={`查看任务 ${item.title}`}
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
                    {item.seq === seq && <Caption accent>定位到的消息 · #{seq}</Caption>}
                    <Caption>
                      {accountName(state.accounts, item.actor)} {verbs[item.change]}「{item.title}」
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
                  ? "正在加载…"
                  : timeline.error
                    ? "消息加载失败。"
                    : "还没有消息，在下面说点什么。"}
              </Label>
            </View>
          }
          ListHeaderComponent={
            state.connection !== "live" ? (
              <View style={{ padding: 12, backgroundColor: c.subtle }}>
                <Label muted>
                  {state.connection === "loading"
                    ? "正在连接…"
                    : state.connection === "connecting"
                      ? "正在连接实时消息…"
                      : "连接中断，正在自动重连。草稿会保留。"}
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
                    title="重试加载"
                    onPress={() => void chat.retryLoad(ref, timeline.loaded)}
                  />
                </View>
              ) : null}
              {entries[0] && !timeline.exhausted && (
                <View style={{ padding: 12 }}>
                  <Button
                    title={timeline.loading ? "正在加载…" : "加载更早的消息"}
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
                    if (activeList.current === listKey) setReadError("已读状态未同步，点此重试。");
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
              title={count ? `${count} 条未读 · 回到最新消息` : "回到最新消息"}
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
                ? `回复 ${conversationLabel(conversation, state.accounts, state.me)} 的讨论串…`
                : conversation.kind === "dm"
                  ? `发消息给 ${conversationLabel(conversation, state.accounts, state.me)}…`
                  : `发送到 ${conversationLabel(conversation, state.accounts, state.me)}…`
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
                ? "这个频道已归档，只能阅读。"
                : conversation.kind === "dm"
                  ? "这段私信仅供阅读。"
                  : "你还没有加入这个会话，加入后才能发言。"}
            </Label>
            {conversation.kind !== "dm" && !conversation.archived && (
              <Button
                title="加入频道"
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
            ? "会话与成员"
            : panel?.kind === "root"
              ? "原帖"
              : panel?.kind === "create-task"
                ? "转为任务"
                : panel?.kind === "task"
                  ? "消息任务"
                  : "消息"
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
              {accountName(state.accounts, messageMenu.author)} ·{" "}
              {new Date(messageMenu.at).toLocaleString("zh-CN")}
            </Caption>
            <Text numberOfLines={3} style={{ fontSize: 17, color: c.foreground, lineHeight: 26 }}>
              {messageMenu.body}
            </Text>
            <Section>
              {thread === null && (
                <Row
                  title="回复讨论串"
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
                  title="转为任务"
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
                title={copiedMessage === messageMenu.messageId ? "已复制消息" : "复制消息"}
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
                  result === "failed" ? "来源消息读取失败，请重试。" : "来源消息已不可用。",
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
