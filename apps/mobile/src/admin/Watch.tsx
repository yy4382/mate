import { useCallback, useReducer, useRef, useState, type ReactNode } from "react";
import { FlatList, Pressable, View } from "react-native";
import { Stack, useFocusEffect } from "expo-router";
import { initialObservation, observeEvents, type Entry, type Observation } from "./observation";
import { useClient, useManagementAccess, useResource } from "./session";
import { useTheme } from "../theme";
import { Button, Caption, Copy, Empty, Row, Section, Select, Sheet, styles } from "../ui";
import { Usage } from "./Usage";
import { ErrorLine } from "./ui";

type Message = NonNullable<Entry["model"]>[number];
type ToolCall = Extract<
  Extract<Message, { role: "assistant" }>["content"][number],
  { type: "toolCall" }
>;
type Reading =
  | { kind: "message"; message: Message; entryId: number }
  | { kind: "tool"; call: ToolCall }
  | { kind: "context" }
  | { kind: "usage" }
  | { kind: "instructions" };
const roleLabel = { system: "系统提示", user: "输入", assistant: "Agent", toolResult: "工具结果" };
const toolLabel = { running: "运行中", done: "已结束", pending: "等待执行" };
const labels: Record<string, string> = {
  command: "命令",
  path: "路径",
  node: "目标 Node",
  timeout: "时限（秒）",
  background: "后台执行",
  content: "内容",
  body: "正文",
  query: "查询",
  name: "名字",
  arguments: "参数",
};
function Values({ value }: { value: unknown }) {
  if (value === undefined) return <Copy muted>未提供。</Copy>;
  if (value === null) return <Copy muted>无</Copy>;
  if (Array.isArray(value) && value.length === 0) return <Copy mono>[]</Copy>;
  if (Array.isArray(value))
    return (
      <View style={{ gap: 8 }}>
        {value.map((item, index) => (
          <Values key={index} value={item} />
        ))}
      </View>
    );
  if (typeof value === "object" && Object.keys(value).length === 0) return <Copy mono>{"{}"}</Copy>;
  if (typeof value === "object")
    return (
      <View style={{ gap: 12 }}>
        {Object.entries(value).map(([key, item]) => (
          <View key={key} style={{ gap: 4 }}>
            <Caption>{labels[key] ?? key}</Caption>
            <Values value={item} />
          </View>
        ))}
      </View>
    );
  return <Copy mono>{typeof value === "boolean" ? (value ? "是" : "否") : String(value)}</Copy>;
}
function MessageBody({ message }: { message: Message }) {
  if (typeof message.content === "string") return <Copy>{message.content}</Copy>;
  return (
    <>
      {message.content.map((block, index) => (
        <View key={index} style={{ gap: 8 }}>
          {block.type === "text" ? (
            <Copy>{block.text}</Copy>
          ) : block.type === "thinking" ? (
            <>
              <Caption>思考</Caption>
              <Copy>{block.thinking}</Copy>
            </>
          ) : block.type === "toolCall" ? (
            <>
              <Copy>调用 {block.name}</Copy>
              <Values value={block.arguments} />
            </>
          ) : (
            <Caption>图片 · {block.mimeType}</Caption>
          )}
        </View>
      ))}
    </>
  );
}
function resultFor(entries: readonly Entry[], callId: string) {
  for (const entry of entries)
    for (const message of entry.model ?? [])
      if (message.role === "toolResult" && message.toolCallId === callId)
        return { message, entryId: entry.id };
  return undefined;
}
function ToolActivity({
  call,
  state,
  onOpen,
}: {
  call: ToolCall;
  state: Observation;
  onOpen(): void;
}) {
  const tool = state.tools[call.id];
  const result = resultFor(state.entries, call.id);
  const output =
    tool?.output ||
    result?.message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
  return (
    <Section>
      <Row
        title={call.name}
        subtitle="参数和完整输出"
        value={
          result
            ? result.message.isError
              ? "出错"
              : "完成"
            : tool
              ? toolLabel[tool.status]
              : "等待执行"
        }
        onPress={onOpen}
      />
      {!!output && (
        <View style={{ padding: 16, gap: 8 }}>
          <Copy mono>
            {output.slice(0, 360)}
            {output.length > 360 ? "…" : ""}
          </Copy>
        </View>
      )}
    </Section>
  );
}
function RecordMessage({
  message,
  entryId,
  state,
  onRead,
}: {
  message: Message;
  entryId: number;
  state: Observation;
  onRead(reading: Reading): void;
}) {
  const c = useTheme();
  if (message.role === "system")
    return (
      <Row
        title="系统提示与工具变更"
        subtitle={`记录 #${entryId}`}
        onPress={() => onRead({ kind: "message", message, entryId })}
      />
    );
  if (
    message.role === "toolResult" &&
    state.entries.some((entry) =>
      entry.model?.some(
        (m) =>
          m.role === "assistant" &&
          m.content.some((block) => block.type === "toolCall" && block.id === message.toolCallId),
      ),
    )
  )
    return null;
  const label = `${roleLabel[message.role]} · 记录 #${entryId} · ${new Date(message.timestamp).toLocaleTimeString("zh-CN")}`;
  return (
    <View
      style={{
        gap: 12,
        borderLeftWidth: 1,
        borderColor: c.border,
        paddingLeft: 16,
        paddingVertical: 8,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`查看记录 #${entryId} 详情`}
        style={{ minHeight: 44, justifyContent: "center" }}
        onPress={() => onRead({ kind: "message", message, entryId })}
      >
        <Caption>{label}</Caption>
      </Pressable>
      {message.role === "assistant" ? (
        <>
          {message.content.map((block, index) =>
            block.type === "text" ? (
              <Copy key={index}>{block.text}</Copy>
            ) : block.type === "toolCall" ? (
              <ToolActivity
                key={block.id}
                call={block}
                state={state}
                onOpen={() => onRead({ kind: "tool", call: block })}
              />
            ) : (
              <Button
                key={index}
                title="查看思考"
                onPress={() => onRead({ kind: "message", message, entryId })}
              />
            ),
          )}
          {message.errorMessage && <ErrorLine error={message.errorMessage} />}
        </>
      ) : message.role === "user" &&
        typeof message.content === "string" &&
        message.content.length > 120 ? (
        <>
          <Copy>{message.content.slice(0, 120)}…</Copy>
          <Button
            title="查看原始输入"
            onPress={() => onRead({ kind: "message", message, entryId })}
          />
        </>
      ) : (
        <MessageBody message={message} />
      )}
    </View>
  );
}
function ReadingBody({
  reading,
  state,
  onRead,
}: {
  reading: Reading;
  state: Observation;
  onRead(reading: Reading): void;
}) {
  if (reading.kind === "usage") return <Usage usage={state.usage} />;
  if (reading.kind === "instructions")
    return <Copy>{state.agent.instructions || "尚未设置说明文字。"}</Copy>;
  if (reading.kind === "context") {
    const head = state.entries.reduce<number | undefined>(
      (latest, entry) => entry.head ?? latest,
      undefined,
    );
    return (
      <>
        <Section>
          <Row title="当前说明文字" onPress={() => onRead({ kind: "instructions" })} />
          <Row title="用量明细" onPress={() => onRead({ kind: "usage" })} />
          <Row title="排队输入" value={String(state.queued)} />
          <Row title="上下文起点" value={head === undefined ? "尚无记录" : `记录 #${head}`} />
        </Section>
        {state.entries
          .filter((entry) => entry.head !== undefined)
          .map((entry) => (
            <View key={entry.id} style={{ gap: 8 }}>
              <Caption>
                上下文更新 · 记录 #{entry.id} · 起点 #{entry.head}
              </Caption>
              {entry.model?.map((message, index) => (
                <MessageBody key={index} message={message} />
              ))}
              {entry.data !== undefined && <Values value={entry.data} />}
            </View>
          ))}
        <Section title="系统提示与工具变更">
          {state.entries.flatMap((entry) =>
            (entry.model ?? [])
              .filter((message) => message.role === "system")
              .map((message, index) => (
                <Row
                  key={`${entry.id}/${index}`}
                  title={`记录 #${entry.id}`}
                  onPress={() => onRead({ kind: "message", message, entryId: entry.id })}
                />
              )),
          )}
        </Section>
        {state.notes.length > 0 && (
          <Section title="诊断记录">
            {state.notes.map((note, index) => (
              <View key={index} style={{ padding: 16 }}>
                <Copy>{note}</Copy>
              </View>
            ))}
          </Section>
        )}
      </>
    );
  }
  if (reading.kind === "tool") {
    const { call } = reading;
    const tool = state.tools[call.id];
    const result = resultFor(state.entries, call.id);
    return (
      <>
        <Copy>{call.name}</Copy>
        <Caption>调用 ID</Caption>
        <Copy mono>{call.id}</Copy>
        <Section title="完整参数">
          <View style={{ padding: 16 }}>
            <Values value={call.arguments} />
          </View>
        </Section>
        {tool && (
          <>
            <Caption>{toolLabel[tool.status]} · 流式输出</Caption>
            <Copy mono>{tool.output || "尚无输出。"}</Copy>
          </>
        )}
        {result && (
          <>
            <Caption>
              完整结果 · 记录 #{result.entryId} · {result.message.isError ? "出错" : "完成"}
            </Caption>
            <MessageBody message={result.message} />
            {result.message.details !== undefined && <Values value={result.message.details} />}
          </>
        )}
        {!result && <Caption>尚无已记录的工具结果。</Caption>}
      </>
    );
  }
  const { message, entryId } = reading;
  return (
    <>
      <Caption>
        {roleLabel[message.role]} · 记录 #{entryId} ·{" "}
        {new Date(message.timestamp).toLocaleString("zh-CN")}
      </Caption>
      <MessageBody message={message} />
      {message.role === "system" && (
        <>
          {Object.entries(message.sections ?? {}).map(([name, content]) => (
            <Section key={name} title={name}>
              <View style={{ padding: 16 }}>
                <Copy>{content ?? "已移除"}</Copy>
              </View>
            </Section>
          ))}
          {message.toolsAdded?.map((tool) => (
            <Section key={tool.name} title={`添加工具 · ${tool.name}`}>
              <View style={{ padding: 16 }}>
                <Values value={tool} />
              </View>
            </Section>
          ))}
          {message.toolsRemoved?.map((tool) => (
            <Copy key={tool.name}>移除工具 · {tool.name}</Copy>
          ))}
        </>
      )}
      {message.role === "assistant" && (
        <>
          <ErrorLine error={message.errorMessage} />
          <Caption>
            模型 · {message.provider} / {message.model}
          </Caption>
          <Values value={message.usage} />
        </>
      )}
      {message.role === "toolResult" && (
        <>
          <Caption>
            {message.toolName} · {message.isError ? "出错" : "完成"} · {message.toolCallId}
          </Caption>
          {message.details !== undefined && <Values value={message.details} />}
        </>
      )}
    </>
  );
}

function ObservationTarget({
  agentId,
  assistant,
  selector,
  navigation,
  name,
}: {
  agentId: string;
  assistant: string;
  selector: ReactNode;
  navigation: ReactNode;
  name: string;
}) {
  const client = useClient();
  const access = useManagementAccess();
  const c = useTheme();
  const [revision, setRevision] = useState(0);
  const [state, dispatch] = useReducer(observeEvents, initialObservation);
  const [problem, setProblem] = useState<unknown>();
  const [connection, setConnection] = useState<"connecting" | "connected" | "disconnected">(
    "connecting",
  );
  const [snapshotAt, setSnapshotAt] = useState<number>();
  const [reading, setReading] = useState<Reading | null>(null);
  const list = useRef<FlatList<Entry>>(null);
  const follow = useRef(true);
  const dragging = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (access.kind !== "ready") return;
      const request = new AbortController();
      setProblem(undefined);
      setConnection("connecting");
      void client
        .observe(agentId, assistant, request.signal, (events) => {
          if (request.signal.aborted) return;
          setConnection("connected");
          if (events !== "ended" && events.some((event) => event.type === "snapshot"))
            setSnapshotAt(Date.now());
          dispatch(events);
        })
        .catch((error) => {
          if (!request.signal.aborted) {
            setProblem(error);
            setConnection("disconnected");
          }
        });
      return () => request.abort();
    }, [client, access, agentId, assistant, revision]),
  );
  const calls = state.entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === "assistant"
        ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
        : [],
    ),
  );
  const head = state.entries.reduce<number | undefined>(
    (latest, entry) => entry.head ?? latest,
    undefined,
  );
  const stale = connection !== "connected" && snapshotAt !== undefined;
  const title =
    reading?.kind === "context"
      ? "上下文与诊断"
      : reading?.kind === "usage"
        ? "用量明细"
        : reading?.kind === "instructions"
          ? "当前说明文字"
          : reading?.kind === "tool"
            ? "工具调用"
            : "记录详情";
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Stack.Screen
        options={{ title: assistant ? `工作助手 · ${assistant}` : `主对话 · ${name}` }}
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="info.circle"
          accessibilityLabel="上下文与诊断"
          hidden={access.kind !== "ready"}
          onPress={() => setReading({ kind: "context" })}
        >
          观察详情
        </Stack.Toolbar.Button>
        <Stack.Toolbar.Button
          icon="arrow.clockwise"
          accessibilityLabel="重新连接观察"
          hidden={access.kind !== "ready"}
          onPress={() => setRevision((old) => old + 1)}
        >
          重新连接
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <FlatList
        ref={list}
        data={state.entries}
        keyExtractor={(entry) => String(entry.id)}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.page, { gap: 16, paddingBottom: 32 }]}
        onScrollBeginDrag={() => {
          dragging.current = true;
        }}
        onScrollEndDrag={() => {
          dragging.current = false;
        }}
        onScroll={({ nativeEvent }) => {
          if (!dragging.current) return;
          follow.current =
            nativeEvent.layoutMeasurement.height + nativeEvent.contentOffset.y >=
            nativeEvent.contentSize.height - 100;
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (follow.current) list.current?.scrollToEnd({ animated: false });
        }}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            {navigation}
            {selector}
            <Caption>
              {state.ended
                ? "观察已结束，Agent 已暂停、删除或控制面已关闭。"
                : connection === "disconnected"
                  ? "观察连接中断"
                  : connection === "connecting"
                    ? "正在连接观察…"
                    : state.run
                      ? "正在执行"
                      : "空闲，等待输入"}
            </Caption>
            <Caption>
              {stale ? `上次快照 ${new Date(snapshotAt).toLocaleTimeString("zh-CN")} · ` : ""}
              排队输入 {state.queued}
              {head === undefined ? "" : ` · 上下文起点 #${head}`}
            </Caption>
            <ErrorLine error={problem} />
            {connection === "disconnected" && !state.ended && (
              <Button title="重新连接观察" onPress={() => setRevision((old) => old + 1)} />
            )}
            {state.entries.length === 0 &&
              Object.keys(state.streaming).length === 0 &&
              connection === "connected" && <Empty title="还没有对话内容" />}
          </View>
        }
        renderItem={({ item: entry }) => (
          <View style={{ gap: 12 }}>
            {head !== undefined && entry.id < head && (
              <Caption>记录 #{entry.id} · 上下文起点之前</Caption>
            )}
            {entry.model?.length ? (
              entry.model.map((message, index) => (
                <RecordMessage
                  key={index}
                  message={message}
                  entryId={entry.id}
                  state={state}
                  onRead={setReading}
                />
              ))
            ) : (
              <Row
                title={entry.head !== undefined ? "上下文已更新" : `记录类型 · ${entry.kind}`}
                subtitle={`记录 #${entry.id}`}
                onPress={() => setReading({ kind: "context" })}
              />
            )}
          </View>
        )}
        ListFooterComponent={
          <View style={{ gap: 16 }}>
            {Object.entries(state.streaming).map(([index, block]) => (
              <View key={index} style={{ gap: 8 }}>
                <Caption>
                  {block.type === "thinking"
                    ? "正在思考…"
                    : block.type === "toolCall"
                      ? "正在准备工具调用…"
                      : "正在写入…"}
                </Caption>
                {block.type === "toolCall" ? (
                  <>
                    <Copy>{block.name}</Copy>
                    <Values value={block.arguments} />
                  </>
                ) : (
                  <Copy>{block.type === "text" ? block.text : block.thinking}</Copy>
                )}
              </View>
            ))}
            {Object.entries(state.tools)
              .filter(([id]) => !calls.includes(id))
              .map(([id, tool]) => (
                <Section key={id} title={`${tool.name} · ${toolLabel[tool.status]}`}>
                  <View style={{ padding: 16, gap: 8 }}>
                    <Copy mono>{tool.output || "尚无输出。"}</Copy>
                    <Values value={tool.args} />
                    <Caption>调用 ID · {id}</Caption>
                  </View>
                </Section>
              ))}
          </View>
        }
      />
      <Sheet visible={reading !== null} title={title} onClose={() => setReading(null)}>
        {reading && <ReadingBody reading={reading} state={state} onRead={setReading} />}
      </Sheet>
    </View>
  );
}
export function Watch({
  agentId,
  name,
  navigation,
}: {
  agentId: string;
  name: string;
  navigation: ReactNode;
}) {
  const assistants = useResource<string[]>(
    `/api/admin/agents/${encodeURIComponent(agentId)}/assistants`,
    5000,
  );
  const [assistant, setAssistant] = useState("");
  const selector = (
    <Section>
      <Select
        label="观察对象"
        value={assistant}
        options={[
          { value: "", label: "主对话" },
          ...(assistants.data ?? []).map((name) => ({ value: name, label: `工作助手 · ${name}` })),
        ]}
        onChange={setAssistant}
      />
      <ErrorLine error={assistants.error} />
      {assistants.error != null && <Button title="重新读取工作助手" onPress={assistants.refresh} />}
    </Section>
  );
  return (
    <ObservationTarget
      key={`${agentId}/${assistant}`}
      agentId={agentId}
      assistant={assistant}
      selector={selector}
      navigation={navigation}
      name={name}
    />
  );
}
