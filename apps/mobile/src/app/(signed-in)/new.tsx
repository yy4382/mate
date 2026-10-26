import { useHeaderHeight } from "@react-navigation/elements";
import { randomUUID } from "expo-crypto";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, View } from "react-native";
import { useChat, useChatState } from "../../session";
import { Button, ErrorLine, Field, Label, styles } from "../../ui";
export default function NewConversation() {
  const headerHeight = useHeaderHeight();
  const chat = useChat();
  const state = useChatState();
  const [mode, setMode] = useState<"channel" | "dm">("channel");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [name, setName] = useState("");
  const [other, setOther] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const request = useRef<{ key: string; id: string } | null>(null);
  async function submit() {
    const input =
      mode === "channel" ? { kind: mode, name, visibility } : { kind: mode, other: other ?? 0 };
    const key = JSON.stringify(input);
    if (request.current?.key !== key) request.current = { key, id: randomUUID() };
    setBusy(true);
    setError("");
    try {
      const result = await chat.create(input, request.current.id);
      if (!mounted.current) return;
      router.dismiss();
      router.push({ pathname: "/conversation", params: { id: result.conversationId } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法创建会话，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={styles.fill}
      keyboardVerticalOffset={headerHeight}
    >
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
        <View style={styles.row}>
          <Button title="频道" primary={mode === "channel"} onPress={() => setMode("channel")} />
          <Button title="私信" primary={mode === "dm"} onPress={() => setMode("dm")} />
        </View>
        {mode === "channel" ? (
          <>
            <Label>频道名称</Label>
            <Field
              testID="channel-name"
              accessibilityLabel="频道名称"
              value={name}
              onChangeText={setName}
            />
            <View style={styles.row}>
              <Button
                title="公开"
                primary={visibility === "public"}
                onPress={() => setVisibility("public")}
              />
              <Button
                title="私有"
                primary={visibility === "private"}
                onPress={() => setVisibility("private")}
              />
            </View>
          </>
        ) : (
          <>
            <Label>选择私信对象</Label>
            {state.accounts
              .filter((a) => a.active && a.accountId !== state.me)
              .map((a) => (
                <Button
                  key={a.accountId}
                  title={`${other === a.accountId ? "已选 · " : ""}${a.displayName}（@${a.handle}）`}
                  onPress={() => setOther(a.accountId)}
                />
              ))}
          </>
        )}
        <ErrorLine text={error} />
        <Button
          title={busy ? "正在打开…" : mode === "channel" ? "创建频道" : "打开私信"}
          primary
          disabled={busy || (mode === "channel" ? !name.trim() : other === null)}
          onPress={() => void submit()}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
