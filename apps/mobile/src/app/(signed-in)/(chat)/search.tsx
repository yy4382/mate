import { Stack } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, Text, View } from "react-native";
import type { Entry } from "@mate/chat/contracts";
import { useChat, useChatState } from "../../../session";
import { accountName } from "../../../chat";
import { Button, Caption, Empty, ErrorLine, Field, Screen } from "../../../ui";
import { MessageBody } from "../../../message-body";
import { useTheme } from "../../../theme";
type Result =
  | { kind: "idle" }
  | { kind: "loading" | "error"; query: string }
  | { kind: "ready"; query: string; hits: Entry[] };
export default function Search() {
  const chat = useChat();
  const state = useChatState();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  async function search() {
    const term = query.trim();
    if (!term || result.kind === "loading") return;
    Keyboard.dismiss();
    const id = ++request.current;
    setResult({ kind: "loading", query: term });
    try {
      const hits = await chat.search(term);
      if (id === request.current) setResult({ kind: "ready", query: term, hits });
    } catch {
      if (id === request.current) setResult({ kind: "error", query: term });
    }
  }
  return (
    <Screen grouped={false}>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          disabled={!query.trim() || result.kind === "loading"}
          onPress={() => void search()}
        >
          搜索
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Field
        testID="search-query"
        accessibilityLabel="搜索词"
        placeholder="在所有可见会话中搜索"
        value={query}
        onChangeText={setQuery}
        returnKeyType="search"
        onSubmitEditing={() => void search()}
        clearButtonMode="while-editing"
      />
      <Caption>
        {result.kind === "ready"
          ? `“${result.query}” · ${result.hits.length} 项结果`
          : "所有可见会话中的消息"}
      </Caption>
      {result.kind === "loading" && <ActivityIndicator accessibilityLabel="正在搜索" />}
      {result.kind === "idle" && (
        <Empty title="输入关键词查找消息" message="使用键盘搜索键或右上角搜索。" />
      )}
      {result.kind === "error" && (
        <>
          <ErrorLine text="搜索未完成，已保留关键词。" />
          <Button title="重试搜索" onPress={() => void search()} />
        </>
      )}
      {result.kind === "ready" && (
        <>
          {result.hits.length === 0 ? (
            <Empty title="没有找到匹配的消息" message="换一个关键词，或清除当前搜索。">
              <Button
                title="清除搜索"
                onPress={() => {
                  request.current++;
                  setQuery("");
                  setResult({ kind: "idle" });
                }}
              />
            </Empty>
          ) : (
            <Caption>搜索结果暂不支持跳转到原消息，可在这里阅读完整内容。</Caption>
          )}
          {result.hits.map((hit) =>
            hit.kind === "message" ? (
              <SearchHit key={`${result.query}/${hit.messageId}`} hit={hit} />
            ) : (
              <View key={`task-${hit.seq}`}>
                <Caption>
                  {accountName(state.accounts, hit.actor)} · 任务{hit.title}
                </Caption>
              </View>
            ),
          )}
        </>
      )}
    </Screen>
  );
}
function SearchHit({ hit }: { hit: Extract<Entry, { kind: "message" }> }) {
  const state = useChatState();
  const c = useTheme();
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ paddingVertical: 16, gap: 10, borderBottomWidth: 1, borderColor: c.border }}>
      <Caption>
        {accountName(state.accounts, hit.author)} · {new Date(hit.at).toLocaleString("zh-CN")}
      </Caption>
      {expanded || hit.body.length <= 240 ? (
        <MessageBody text={hit.body} accounts={state.accounts} mentions={hit.mentions} />
      ) : (
        <Text numberOfLines={5} style={{ fontSize: 17, lineHeight: 26, color: c.foreground }}>
          {hit.body}
        </Text>
      )}
      {hit.body.length > 240 && (
        <Button
          title={expanded ? "收起消息" : "展开完整消息"}
          onPress={() => setExpanded(!expanded)}
        />
      )}
      {expanded &&
        hit.attachments.map((a, i) => (
          <Caption key={i}>
            附件：{a.name}（{a.size} 字节，暂不支持下载）
          </Caption>
        ))}
    </View>
  );
}
