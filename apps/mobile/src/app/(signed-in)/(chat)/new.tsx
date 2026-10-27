import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useChat, useChatState } from "../../../session";
import {
  Avatar,
  Button,
  Card,
  ErrorLine,
  Field,
  Label,
  Row,
  Section,
  Sheet,
  styles,
} from "../../../ui";
export default function NewConversation() {
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
      router.back();
      router.push({ pathname: "/conversation", params: { id: result.conversationId } });
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "无法创建会话，请重试。");
    }
  }
  const [query, setQuery] = useState("");
  return (
    <Sheet title="新建会话" onClose={() => router.back()}>
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
          <Card>
            <Field
              label="频道名称"
              testID="channel-name"
              editable={!pending}
              value={name}
              onChangeText={setName}
            />
          </Card>
          <Section
            title="可见性"
            footer={
              visibility === "public"
                ? "公开频道。Agent 不加入也可读；发言与建任务需要加入。人类可阅读所有会话。"
                : "私有频道。Agent 只有成员可读。人类仍可阅读所有会话；发言与建任务需要加入。"
            }
          >
            <Row
              title="公开"
              selected={visibility === "public"}
              disabled={!!pending}
              onPress={() => setVisibility("public")}
            />
            <Row
              title="私有"
              selected={visibility === "private"}
              disabled={!!pending}
              onPress={() => setVisibility("private")}
            />
          </Section>
        </>
      ) : (
        <>
          <Field
            label="查找账号"
            value={query}
            onChangeText={setQuery}
            clearButtonMode="while-editing"
          />
          <Section title="选择私信对象">
            {state.accounts
              .filter(
                (a) =>
                  a.active &&
                  a.accountId !== state.me &&
                  `${a.displayName} ${a.handle}`
                    .toLocaleLowerCase()
                    .includes(query.toLocaleLowerCase()),
              )
              .map((a) => (
                <Row
                  key={a.accountId}
                  title={a.displayName}
                  subtitle={`@${a.handle} · ${a.kind === "agent" ? "Agent" : "人类"}`}
                  leading={<Avatar name={a.displayName} kind={a.kind} />}
                  selected={other === a.accountId}
                  disabled={!!pending}
                  onPress={() => setOther(a.accountId)}
                />
              ))}
          </Section>
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
    </Sheet>
  );
}
