import { useHeaderHeight } from "@react-navigation/elements";
import { router, Stack } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, View } from "react-native";
import { useChat, useChatState } from "../../session";
import { Button, ErrorLine, Field, Label, styles } from "../../ui";
export default function NewConversation() {
  const headerHeight = useHeaderHeight();
  const chat = useChat();
  const state = useChatState();
  const pending = state.operations.get("new-conversation");
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
      if (!mounted.current) return;
      router.dismiss();
      router.push({ pathname: "/conversation", params: { id: result.conversationId } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法创建会话，请重试。");
    }
  }
  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={styles.fill}
      keyboardVerticalOffset={headerHeight}
    >
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button onPress={() => router.back()}>关闭</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
        <View style={styles.row}>
          <Button
            disabled={!!pending}
            title="频道"
            primary={mode === "channel"}
            onPress={() => setMode("channel")}
          />
          <Button
            disabled={!!pending}
            title="私信"
            primary={mode === "dm"}
            onPress={() => setMode("dm")}
          />
        </View>
        {mode === "channel" ? (
          <>
            <Label>频道名称</Label>
            <Field
              testID="channel-name"
              accessibilityLabel="频道名称"
              editable={!pending}
              value={name}
              onChangeText={setName}
            />
            <View style={styles.row}>
              <Button
                disabled={!!pending}
                title="公开"
                primary={visibility === "public"}
                onPress={() => setVisibility("public")}
              />
              <Button
                disabled={!!pending}
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
                  disabled={!!pending}
                  title={`${other === a.accountId ? "已选 · " : ""}${a.displayName}（@${a.handle}）`}
                  onPress={() => setOther(a.accountId)}
                />
              ))}
          </>
        )}
        {pending && <Label>上次操作结果尚未确认，重试将使用原请求。</Label>}
        <ErrorLine text={pending?.error || error} />
        <Button
          title={
            busy
              ? "正在打开…"
              : pending
                ? "重试打开会话"
                : mode === "channel"
                  ? "创建频道"
                  : "打开私信"
          }
          primary
          disabled={busy || (mode === "channel" ? !name.trim() : other === null)}
          onPress={() => void submit()}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
