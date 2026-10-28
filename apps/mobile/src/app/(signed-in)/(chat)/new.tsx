import { t } from "../../../i18n";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { operationKey } from "../../../chat";
import { AccountPicker } from "../../../chat-actions";
import { useChat, useChatState } from "../../../session";
import { Button, Card, ErrorLine, Field, Label, Row, Section, Sheet, styles } from "../../../ui";
export default function NewConversation() {
  const chat = useChat();
  const state = useChatState();
  const pending = state.operations.get(operationKey.creation);
  const saved = pending?.input;
  const [mode, setMode] = useState<"channel" | "dm">(saved?.kind === "dm" ? "dm" : "channel");
  const [visibility, setVisibility] = useState<"public" | "private">(
    saved?.kind === "channel" ? saved.visibility : "public",
  );
  const [name, setName] = useState(saved?.kind === "channel" ? saved.name : "");
  const [other, setOther] = useState<number | null>(saved?.kind === "dm" ? saved.other : null);
  const busy = pending?.status === "sending";
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function submit() {
    const input =
      mode === "channel" ? { kind: mode, name, visibility } : { kind: mode, other: other ?? 0 };
    setError("");
    try {
      const result = await chat.create(input);
      // A sheet closed during the request must not navigate the screen beneath it.
      if (!mounted.current) return;
      router.back();
      router.push({ pathname: "/conversation", params: { id: result.conversationId } });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("chat.could_not_create_the_conversation_retry"));
    }
  }
  const [query, setQuery] = useState("");
  return (
    <Sheet title={t("chat.new_conversation")} onClose={() => router.back()}>
      <View style={styles.row}>
        <Button
          disabled={!!pending}
          title={t("chat.channel")}
          primary={mode === "channel"}
          onPress={() => setMode("channel")}
        />
        <Button
          disabled={!!pending}
          title={t("chat.direct_message")}
          primary={mode === "dm"}
          onPress={() => setMode("dm")}
        />
      </View>
      {mode === "channel" ? (
        <>
          <Card>
            <Field
              label={t("chat.channel_name")}
              testID="channel-name"
              editable={!pending}
              value={name}
              onChangeText={setName}
            />
          </Card>
          <Section
            title={t("chat.visibility")}
            footer={
              visibility === "public"
                ? t("chat.public_channel_agents_can_read_without_joining")
                : t("chat.private_channel_only_agent_members_can_read")
            }
          >
            <Row
              title={t("chat.public")}
              selected={visibility === "public"}
              disabled={!!pending}
              onPress={() => setVisibility("public")}
            />
            <Row
              title={t("chat.private")}
              selected={visibility === "private"}
              disabled={!!pending}
              onPress={() => setVisibility("private")}
            />
          </Section>
        </>
      ) : (
        <AccountPicker
          title={t("chat.choose_a_recipient")}
          accounts={state.accounts.filter((a) => a.active && a.accountId !== state.me)}
          query={query}
          onQuery={setQuery}
          selected={other}
          onSelect={setOther}
          disabled={!!pending}
        />
      )}
      {pending && <Label>{t("chat.the_previous_operation_is_unconfirmed_retrying_uses")}</Label>}
      <ErrorLine text={pending?.error || error} />
      <Button
        title={
          busy
            ? t("chat.opening")
            : pending
              ? t("chat.retry_opening_conversation")
              : mode === "channel"
                ? t("chat.create_channel")
                : t("chat.open_direct_message")
        }
        primary
        disabled={busy || (mode === "channel" ? !name.trim() : other === null)}
        onPress={() => void submit()}
      />
    </Sheet>
  );
}
