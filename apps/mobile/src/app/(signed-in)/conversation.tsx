import { useHeaderHeight } from "@react-navigation/elements";
import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  Text,
  View,
  type FlatListProps,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Entry, TimelineRef } from "@mate/chat/contracts";
import { accountName, conversationLabel, timelineKey } from "../../chat";
import { ConversationActions, CreateTask, TaskActions } from "../../chat-actions";
import { MessageBody } from "../../message-body";
import { useChat, useChatState } from "../../session";
import { Button, ErrorLine, Field, Label, styles } from "../../ui";
import { useTheme } from "../../theme";

const verbs = {
  created: "创建了任务",
  claimed: "认领了任务",
  yielded: "让出了任务",
  transferred: "转交了任务",
  completed: "完成了任务",
};
export default function ConversationScreen() {
  const headerHeight = useHeaderHeight();
  const params = useLocalSearchParams<{ id: string; thread?: string; seq?: string }>();
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
  const [more, setMore] = useState(false);
  const [tasking, setTasking] = useState<Extract<Entry, { kind: "message" }> | null>(null);
  const [task, setTask] = useState<Extract<Entry, { kind: "task" }> | null>(null);
  const [rootError, setRootError] = useState("");
  const [destination, setDestination] = useState<
    "loading" | "positioning" | "done" | "missing" | "failed"
  >(seq === null ? "done" : "loading");
  const [destinationRetry, setDestinationRetry] = useState(0);
  const jump = useRef<{ seq: number; attempts: number; measured: number } | null>(null);
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
    list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: false });
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
        if (viewableItems.some((item) => item.isViewable && item.item.seq === jump.current?.seq)) {
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
      () => setReadError(""),
      () => {
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
        if (visibleEntries.current.key === listKey && visibleEntries.current.entries.has(seq))
          setDestination("done");
        else {
          jump.current = { seq, attempts: 0, measured: -1 };
          setDestination("positioning");
          schedulePosition();
        }
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
  function message(entry: Extract<Entry, { kind: "message" }>, isRoot = false) {
    const author = state.accounts.find((a) => a.accountId === entry.author);
    const related = visibleTasks.filter((t) => t.messageId === entry.messageId);
    return (
      <View
        testID={isRoot ? "thread-root" : `entry-${entry.seq}`}
        style={{
          padding: 16,
          gap: 8,
          borderBottomWidth: 1,
          borderColor: c.border,
          backgroundColor: isRoot || entry.seq === seq ? c.subtle : c.background,
        }}
      >
        {entry.seq === seq && !isRoot && <Label>定位到的消息 · #{seq}</Label>}
        <View style={styles.row}>
          <Text style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}>
            {accountName(state.accounts, entry.author)}
          </Text>
          <Label muted>
            @{author?.handle ?? "?"} ·{" "}
            {new Date(entry.at).toLocaleString("zh-CN", {
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Label>
        </View>
        <MessageBody text={entry.body} accounts={state.accounts} mentions={entry.mentions} />
        {entry.attachments.map((a, i) => (
          <Label key={i} muted>
            附件：{a.name}（{a.size} 字节，暂不支持下载）
          </Label>
        ))}
        {related.map((t) => (
          <Pressable
            key={t.taskId}
            accessibilityRole="button"
            disabled={!canWrite}
            onPress={() => setTask(t)}
            style={{ padding: 12, gap: 4, borderWidth: 1, borderColor: c.border, borderRadius: 6 }}
          >
            <Label>
              {t.change === "completed" ? "已完成 · " : "任务 · "}
              {t.title}
            </Label>
            <Label muted>
              {t.owner === null ? "无人认领" : `负责人：${accountName(state.accounts, t.owner)}`}
              {canWrite && t.change !== "completed" ? " · 点此操作" : ""}
            </Label>
          </Pressable>
        ))}
        {!isRoot && (
          <View style={styles.row}>
            {thread === null && (
              <Button
                testID={`reply-${entry.messageId}`}
                title="回复讨论串"
                onPress={() =>
                  router.push({
                    pathname: "/conversation",
                    params: { id, thread: entry.messageId },
                  })
                }
              />
            )}{" "}
            {canWrite && (
              <Button
                testID={`create-task-${entry.messageId}`}
                title="转为任务"
                onPress={() => setTasking(entry)}
              />
            )}
          </View>
        )}
      </View>
    );
  }

  if (!conversation)
    return (
      <View style={styles.page}>
        <Label>找不到这个会话。请返回列表重试。</Label>
      </View>
    );
  return (
    <SafeAreaView edges={["bottom", "left", "right"]} style={styles.fill}>
      <Stack.Screen
        options={{
          headerBackVisible: false,
          title:
            thread === null ? conversationLabel(conversation, state.accounts, state.me) : "讨论串",
        }}
      />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon="chevron.left"
          accessibilityLabel="返回"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/chat"))}
        >
          返回
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button onPress={() => setMore(true)}>更多</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior="padding"
        keyboardVerticalOffset={headerHeight}
      >
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
                  void chat.retryLoad(ref).then(() => setDestinationRetry((x) => x + 1))
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
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          maintainVisibleContentPosition={
            seq === null ? { minIndexForVisible: 0, autoscrollToTopThreshold: 80 } : undefined
          }
          viewabilityConfig={{ viewAreaCoveragePercentThreshold: 30 }}
          onViewableItemsChanged={viewable}
          onScrollToIndexFailed={({ index, averageItemLength, highestMeasuredFrameIndex }) => {
            if (activeList.current !== listKey) return;
            const target = jump.current;
            if (target && highestMeasuredFrameIndex > target.measured) {
              target.measured = highestMeasuredFrameIndex;
              target.attempts = 0;
            }
            list.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
          }}
          keyExtractor={(entry) => String(entry.seq)}
          onScroll={(event) => {
            if (activeList.current === listKey) setBottom(event.nativeEvent.contentOffset.y < 80);
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
          renderItem={({ item }) =>
            item.kind === "message" ? (
              message(item)
            ) : (
              <View testID={`entry-${item.seq}`} style={{ padding: 12, backgroundColor: c.subtle }}>
                {item.seq === seq && <Label>定位到的消息 · #{seq}</Label>}
                <Label muted>
                  {accountName(state.accounts, item.actor)} {verbs[item.change]}「{item.title}」
                </Label>
                {canWrite && (
                  <Button
                    title={`查看任务 ${item.title}`}
                    onPress={() => setTask(tasks.get(item.taskId) ?? item)}
                  />
                )}
              </View>
            )
          }
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
              {root && message(root, true)}
              <ErrorLine text={rootError} />
              {rootError && (
                <Button
                  title="重试根消息"
                  onPress={() =>
                    void chat
                      .retryLoad({ conversation: id })
                      .then(() => setDestinationRetry((x) => x + 1))
                  }
                />
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
                  () => setReadError(""),
                  () => setReadError("已读状态未同步，点此重试。"),
                )
              }
            />
          </View>
        ) : null}
        {!bottom && !composing && destination === "done" && (
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
          <ScrollView
            testID="message-composer-panel"
            style={{ flexGrow: 0, flexShrink: 0, maxHeight: "65%" }}
            contentContainerStyle={{
              padding: 12,
              gap: 8,
              borderTopWidth: 1,
              borderColor: c.border,
            }}
            keyboardShouldPersistTaps="handled"
          >
            <Field
              testID="message-composer"
              accessibilityLabel="消息"
              placeholder={
                thread === null ? "发送消息，使用 @handle 提及" : "回复讨论串，使用 @handle 提及"
              }
              multiline
              value={draft.text}
              onChangeText={(text) => chat.edit(ref, text)}
              onFocus={() => setComposing(true)}
              onBlur={() => setComposing(false)}
              style={{ maxHeight: 160, textAlignVertical: "top" }}
            />
            {/@[\p{L}\p{N}_.-]*$/u.test(draft.text) && (
              <View style={styles.row}>
                {state.accounts
                  .filter(
                    (a) =>
                      a.active &&
                      a.handle
                        .toLowerCase()
                        .startsWith(
                          (draft.text.match(/@([\p{L}\p{N}_.-]*)$/u)?.[1] ?? "").toLowerCase(),
                        ),
                  )
                  .slice(0, 5)
                  .map((a) => (
                    <Button
                      key={a.accountId}
                      title={`@${a.handle}`}
                      onPress={() =>
                        chat.edit(ref, draft.text.replace(/@[\p{L}\p{N}_.-]*$/u, `@${a.handle} `))
                      }
                    />
                  ))}
              </View>
            )}
            <ErrorLine text={draft.error} />
            <View style={[styles.row, { justifyContent: "flex-end" }]}>
              {composing && <Button title="收起键盘" onPress={Keyboard.dismiss} />}
              {draft.pending?.status === "failed" && (
                <Button title="取消本次发送" onPress={() => chat.abandon(ref)} />
              )}
              <Button
                title={
                  draft.pending?.status === "sending"
                    ? "发送中…"
                    : draft.pending?.status === "failed"
                      ? "重试发送"
                      : "发送"
                }
                primary
                disabled={
                  draft.pending?.status === "sending" || (!draft.pending && !draft.text.trim())
                }
                onPress={() => void chat.send(ref)}
              />
            </View>
          </ScrollView>
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
              <Button title="加入频道" onPress={() => setMore(true)} />
            )}
          </View>
        )}
      </KeyboardAvoidingView>
      {more && <ConversationActions conversation={conversation} onClose={() => setMore(false)} />}{" "}
      {tasking && <CreateTask entry={tasking} onClose={() => setTasking(null)} />}{" "}
      {task && <TaskActions task={tasks.get(task.taskId) ?? task} onClose={() => setTask(null)} />}
    </SafeAreaView>
  );
}
