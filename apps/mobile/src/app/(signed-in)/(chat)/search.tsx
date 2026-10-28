import { t, dateText, numberText } from "../../../i18n";
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
          {t("chat.search")}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Field
        testID="search-query"
        accessibilityLabel={t("chat.search_terms")}
        placeholder={t("chat.search_all_visible_conversations")}
        value={query}
        onChangeText={setQuery}
        returnKeyType="search"
        onSubmitEditing={() => void search()}
        clearButtonMode="while-editing"
      />
      <Caption>
        {result.kind === "ready"
          ? t("chat.search_results", { query: result.query, count: result.hits.length })
          : t("chat.messages_in_all_visible_conversations")}
      </Caption>
      {result.kind === "loading" && <ActivityIndicator accessibilityLabel={t("chat.searching")} />}
      {result.kind === "idle" && (
        <Empty
          title={t("chat.enter_keywords_to_find_messages")}
          message={t("chat.use_the_keyboard_search_key_or_search")}
        />
      )}
      {result.kind === "error" && (
        <>
          <ErrorLine text={t("chat.search_did_not_finish_your_keywords_are")} />
          <Button title={t("chat.retry_search")} onPress={() => void search()} />
        </>
      )}
      {result.kind === "ready" && (
        <>
          {result.hits.length === 0 ? (
            <Empty
              title={t("chat.no_matching_messages")}
              message={t("chat.try_another_keyword_or_clear_this_search")}
            >
              <Button
                title={t("chat.clear_search")}
                onPress={() => {
                  request.current++;
                  setQuery("");
                  setResult({ kind: "idle" });
                }}
              />
            </Empty>
          ) : (
            <Caption>{t("chat.search_results_cannot_open_the_original_message")}</Caption>
          )}
          {result.hits.map((hit) =>
            hit.kind === "message" ? (
              <SearchHit key={`${result.query}/${hit.messageId}`} hit={hit} />
            ) : (
              <View key={`task-${hit.seq}`}>
                <Caption>
                  {t("chat.search_task", {
                    name: accountName(state.accounts, hit.actor),
                    title: hit.title,
                  })}
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
        {accountName(state.accounts, hit.author)} · {dateText(hit.at)}
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
          title={expanded ? t("chat.collapse_message") : t("chat.expand_full_message")}
          onPress={() => setExpanded(!expanded)}
        />
      )}
      {expanded &&
        hit.attachments.map((a, i) => (
          <Caption key={i}>
            {t("chat.attachment", { name: a.name, count: a.size, size: numberText(a.size) })}
          </Caption>
        ))}
    </View>
  );
}
