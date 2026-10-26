import { useState } from "react";
import { ScrollView, View } from "react-native";
import type { Entry } from "@mate/chat/contracts";
import { useChat, useChatState } from "../../../session";
import { accountName } from "../../../chat";
import { Button, Card, ErrorLine, Field, Label, styles } from "../../../ui";
import { MessageBody } from "../../../message-body";
export default function Search() {
  const chat = useChat();
  const state = useChatState();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Entry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function search() {
    setBusy(true);
    setError("");
    try {
      setHits(await chat.search(query.trim()));
    } catch {
      setError("搜索失败，请检查网络后重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={styles.page}
    >
      <Field
        testID="search-query"
        accessibilityLabel="搜索词"
        placeholder="在所有可见会话中搜索"
        value={query}
        onChangeText={setQuery}
        returnKeyType="search"
        onSubmitEditing={() => void search()}
      />
      <Button
        title={busy ? "搜索中…" : "搜索"}
        primary
        disabled={busy || !query.trim()}
        onPress={() => void search()}
      />
      <ErrorLine text={error} />
      {hits?.length === 0 && <Label>没有找到匹配的消息，换个关键词试试。</Label>}
      {hits
        ?.filter((e) => e.kind === "message")
        .map((hit) => (
          <Card key={hit.messageId}>
            <Label>
              {accountName(state.accounts, hit.author)} · {new Date(hit.at).toLocaleString("zh-CN")}
            </Label>
            <MessageBody text={hit.body} accounts={state.accounts} mentions={hit.mentions} />
          </Card>
        ))}
      {hits && hits.length > 0 && (
        <View>
          <Label muted>搜索结果暂不支持跳转到原消息。</Label>
        </View>
      )}
    </ScrollView>
  );
}
