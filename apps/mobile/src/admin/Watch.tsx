import type { SnapshotEvent } from "@mate/admin";
import { useCallback, useReducer, useState } from "react";
import { FlatList, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { initialObservation, observeEvents, type Entry } from "./observation";
import { useClient, useManagementAccess, useResource } from "./session";
import { Usage } from "./Usage";
import { Button, Card, Copy, ErrorLine, Select } from "./ui";

type Message = NonNullable<Entry["model"]>[number];
const roleLabel = { system: "系统提示", user: "输入", assistant: "Agent", toolResult: "工具结果" };
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
  if (value === undefined) return <Copy muted>未提供参数。</Copy>;
  if (value === null) return <Copy muted>无</Copy>;
  if (Array.isArray(value))
    return (
      <View style={{ gap: 8 }}>
        {value.map((item, index) => (
          <Values key={index} value={item} />
        ))}
      </View>
    );
  if (typeof value === "object")
    return (
      <View style={{ gap: 10 }}>
        {Object.entries(value).map(([key, item]) => (
          <View key={key} style={{ gap: 4 }}>
            <Copy muted>{labels[key] ?? key}</Copy>
            <Values value={item} />
          </View>
        ))}
      </View>
    );
  return <Copy mono>{typeof value === "boolean" ? (value ? "是" : "否") : String(value)}</Copy>;
}
function MessageBody({ message }: { message: Message }) {
  if (typeof message.content === "string") return <Copy mono>{message.content}</Copy>;
  return (
    <>
      {message.content.map((block, index) => (
        <View key={index} style={{ gap: 8 }}>
          {block.type === "text" ? (
            <Copy mono>{block.text}</Copy>
          ) : block.type === "thinking" ? (
            <>
              <Copy muted>思考</Copy>
              <Copy mono>{block.thinking}</Copy>
            </>
          ) : block.type === "toolCall" ? (
            <Card>
              <Copy>调用 {block.name}</Copy>
              <Values value={block.arguments} />
            </Card>
          ) : (
            <Copy muted>图片 · {block.mimeType}</Copy>
          )}
        </View>
      ))}
    </>
  );
}
function TranscriptMessage({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(message.role !== "system");
  return (
    <Card>
      <Copy>
        {roleLabel[message.role]} · {new Date(message.timestamp).toLocaleTimeString("zh-CN")}
      </Copy>
      {message.role === "system" && (
        <Button
          title={expanded ? "收起系统提示" : "展开系统提示"}
          onPress={() => setExpanded(!expanded)}
        />
      )}
      {expanded && (
        <>
          <MessageBody message={message} />
          {message.role === "system" && (
            <>
              {Object.entries(message.sections ?? {}).map(([name, content]) => (
                <View key={name}>
                  <Copy>{name}</Copy>
                  <Copy mono>{content ?? "已移除"}</Copy>
                </View>
              ))}
              {message.toolsAdded?.map((tool) => (
                <View key={`${tool.name}`}>
                  <Copy>可用工具 · {tool.name}</Copy>
                  <Copy muted>{tool.description}</Copy>
                </View>
              ))}
              {message.toolsRemoved?.map((tool) => (
                <Copy key={tool.name} muted>
                  移除工具 · {tool.name}
                </Copy>
              ))}
            </>
          )}
          {message.role === "toolResult" && (
            <Copy muted>
              {message.toolName} · {message.isError ? "出错" : "完成"}
            </Copy>
          )}
          {message.role === "assistant" && message.errorMessage && (
            <ErrorLine error={message.errorMessage} />
          )}
        </>
      )}
    </Card>
  );
}
function StreamBlock({
  block,
}: {
  block: Extract<Message, { role: "assistant" }>["content"][number];
}) {
  return (
    <Card>
      <Copy muted>
        正在
        {block.type === "thinking" ? "思考" : block.type === "toolCall" ? "准备工具调用" : "写入"}…
      </Copy>
      {block.type === "toolCall" ? (
        <>
          <Copy>{block.name}</Copy>
          <Values value={block.arguments} />
        </>
      ) : (
        <Copy mono>{block.type === "text" ? block.text : block.thinking}</Copy>
      )}
    </Card>
  );
}
export function Watch({ agentId, onBack }: { agentId: string; onBack: () => void }) {
  const client = useClient();
  const access = useManagementAccess();
  const assistants = useResource<string[]>(
    `/api/admin/agents/${encodeURIComponent(agentId)}/assistants`,
    5000,
  );
  const [assistant, setAssistant] = useState("");
  const [revision, setRevision] = useState(0);
  const [state, dispatch] = useReducer(observeEvents, initialObservation);
  const [problem, setProblem] = useState<unknown>();
  const [connected, setConnected] = useState(false);
  useFocusEffect(
    useCallback(() => {
      if (access.kind !== "ready") return;
      const request = new AbortController();
      setProblem(undefined);
      setConnected(false);
      dispatch([
        {
          type: "snapshot",
          entries: [],
          tools: [],
          compactions: [],
          inbox: [],
          agent: {},
          usage: { models: {}, tools: {} },
        } satisfies SnapshotEvent,
      ]);
      void client
        .observe(agentId, assistant, request.signal, (events) => {
          setConnected(true);
          dispatch(events);
        })
        .catch((error) => {
          if (!request.signal.aborted) setProblem(error);
        });
      return () => request.abort();
    }, [client, access, agentId, assistant, revision]),
  );
  const head = state.entries.reduce<number | undefined>(
    (latest, entry) => entry.head ?? latest,
    undefined,
  );
  return (
    <SafeAreaView style={{ flex: 1 }} edges={["left", "right", "bottom"]}>
      <FlatList
        data={state.entries}
        keyExtractor={(entry) => String(entry.id)}
        contentContainerStyle={{
          padding: 16,
          gap: 16,
          paddingBottom: 40,
          width: "100%",
          maxWidth: 720,
          alignSelf: "center",
        }}
        ListHeaderComponent={
          <View style={{ gap: 16 }}>
            <Button title="返回 Agent 设置" onPress={onBack} />
            <Copy title>观察 Agent</Copy>
            <Copy muted>只读查看当前对话、上下文、工具和用量，不会向 Agent 发送消息。</Copy>
            <Select
              label="观察对象"
              value={assistant}
              options={[
                { value: "", label: "Agent 本身" },
                ...(assistants.data ?? []).map((name) => ({
                  value: name,
                  label: `工作助手 ${name}`,
                })),
              ]}
              onChange={setAssistant}
            />
            <ErrorLine error={assistants.error} />
            <ErrorLine error={problem} />
            <Button
              title="重新连接观察"
              onPress={() => {
                assistants.refresh();
                setRevision((old) => old + 1);
              }}
            />
            <Copy>
              {state.ended
                ? "观察已结束，Agent 已暂停、删除或控制面已关闭。"
                : problem
                  ? "观察连接中断，请重试。"
                  : !connected
                    ? "正在连接观察…"
                    : state.run
                      ? "正在执行 run"
                      : "空闲，等待输入"}
            </Copy>
            <Copy muted>
              排队输入 {state.queued}
              {head === undefined ? "" : ` · 上下文起点 #${head}`}
            </Copy>
            {state.agent.instructions && (
              <Card>
                <Copy>当前说明文字</Copy>
                <Copy mono>{state.agent.instructions}</Copy>
              </Card>
            )}
            <Usage usage={state.usage} />
            <Copy title>对话记录</Copy>
            {state.entries.length === 0 && (
              <Copy muted>{connected ? "还没有对话内容。" : "等待快照。"}</Copy>
            )}
          </View>
        }
        renderItem={({ item: entry }) => (
          <View key={entry.id} style={{ gap: 8 }}>
            <Copy muted>
              记录 #{entry.id}
              {head !== undefined && entry.id < head ? " · 上下文起点之前" : ""}
            </Copy>
            {entry.model?.length ? (
              entry.model.map((message, index) => (
                <TranscriptMessage key={index} message={message} />
              ))
            ) : (
              <Copy muted>
                {entry.head !== undefined ? "上下文已更新。" : `记录类型 · ${entry.kind}`}
              </Copy>
            )}
          </View>
        )}
        ListFooterComponent={
          <View style={{ gap: 16 }}>
            {" "}
            {Object.entries(state.streaming).map(([index, block]) => (
              <StreamBlock key={index} block={block} />
            ))}
            {Object.keys(state.tools).length > 0 && <Copy title>工具调用</Copy>}
            {Object.entries(state.tools).map(([id, tool]) => (
              <Card key={id}>
                <Copy>
                  {tool.name} ·{" "}
                  {tool.status === "running"
                    ? "运行中"
                    : tool.status === "done"
                      ? "已结束"
                      : "等待执行"}
                </Copy>
                <Values value={tool.args} />
                {tool.output && (
                  <>
                    <Copy muted>输出</Copy>
                    <Copy mono>{tool.output}</Copy>
                  </>
                )}
              </Card>
            ))}
            {state.notes.map((note, index) => (
              <Copy key={index} muted>
                {note}
              </Copy>
            ))}
          </View>
        }
      />
    </SafeAreaView>
  );
}
