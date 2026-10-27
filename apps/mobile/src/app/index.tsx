import { useRef, useState, useSyncExternalStore, type ComponentRef } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  ScrollView,
  TextInput,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Redirect } from "expo-router";
import { auth } from "../auth-native";
import { useTheme } from "../theme";
import {
  Avatar,
  Button,
  Caption,
  Card,
  ConfirmButton,
  Copy,
  ErrorLine,
  Field,
  Heading,
  PresentationAccess,
  Row,
  Section,
} from "../ui";

function ServerForm({
  initial,
  message,
  onClose,
}: {
  initial: string;
  message: string;
  onClose(): void;
}) {
  const [address, setAddress] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy) return;
    Keyboard.dismiss();
    setBusy(true);
    await auth.changeServer(address);
    setBusy(false);
    if (auth.getSnapshot().kind !== "server") onClose();
  };
  return (
    <>
      <Heading>{initial ? "更换服务器" : "连接 Mate"}</Heading>
      <Copy muted>输入你的 Mate 服务器地址，使用人类账号登录。</Copy>
      <Card>
        <Field
          label="服务器地址"
          testID="server-address"
          value={address}
          onChangeText={setAddress}
          editable={!busy}
          keyboardType="url"
          textContentType="URL"
          placeholder="https://mate.example.com"
          hint="使用 HTTPS 地址，不含账号、路径或查询参数。"
          returnKeyType="done"
          onSubmitEditing={Keyboard.dismiss}
        />
        <ErrorLine text={message} />
      </Card>
      {initial ? (
        <ConfirmButton
          title="保存服务器"
          question="更换服务器？"
          message="当前登录会退出，本次登录的草稿会清除。你需要在新服务器重新登录。"
          confirmLabel="更换并退出"
          disabled={busy || !address.trim()}
          onConfirm={() => void save()}
        />
      ) : (
        <Button
          title={busy ? "正在连接…" : "保存服务器"}
          primary
          disabled={busy || !address.trim()}
          onPress={() => void save()}
        />
      )}
      {initial && <Button title="取消" disabled={busy} onPress={onClose} />}
    </>
  );
}

function LoginForm({ busy, message }: { busy: boolean; message: string }) {
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const c = useTheme();
  const submit = () => {
    if (busy || !handle.trim() || !password) return;
    Keyboard.dismiss();
    void auth.login(handle.trim(), password);
    setPassword("");
  };
  return (
    <>
      <Heading>登录 Mate</Heading>
      <Copy muted>使用这台服务器上的人类账号。</Copy>
      <Card>
        <Field
          label="Handle"
          testID="login-handle"
          value={handle}
          onChangeText={setHandle}
          editable={!busy}
          textContentType="username"
          returnKeyType="next"
          onSubmitEditing={() => passwordField.current?.focus()}
          submitBehavior="submit"
        />
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 15, fontWeight: "500", color: c.muted }}>密码</Text>
          <TextInput
            ref={passwordField}
            accessibilityLabel="密码"
            testID="login-password"
            value={password}
            onChangeText={setPassword}
            editable={!busy}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={submit}
            style={{
              minHeight: 48,
              padding: 12,
              borderRadius: 10,
              fontSize: 17,
              color: c.foreground,
              backgroundColor: c.subtle,
            }}
          />
        </View>
        {message !== "" && (
          <View accessibilityRole="alert">
            <Copy>{message}</Copy>
          </View>
        )}
      </Card>
      <Button
        title={busy ? "正在登录…" : "登录"}
        primary
        disabled={busy || !handle.trim() || !password}
        onPress={submit}
      />
    </>
  );
}

export default function HomeScreen({ account = false }: { account?: boolean }) {
  const c = useTheme();
  const state = useSyncExternalStore(auth.subscribe, auth.getSnapshot);
  const [editingServer, setEditingServer] = useState(false);
  const server = "server" in state ? state.server : "";
  const clearing = state.kind === "clearing";
  if (state.kind === "signed-in" && !account && !editingServer) return <Redirect href="/chat" />;
  const content = (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: c.grouped }}
      edges={
        account && state.kind === "signed-in"
          ? ["left", "right"]
          : ["top", "left", "right", "bottom"]
      }
    >
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={{
            padding: 20,
            paddingBottom: 40,
            gap: 24,
            maxWidth: 720,
            width: "100%",
            alignSelf: "center",
          }}
        >
          {(editingServer || state.kind === "server") && !clearing ? (
            <ServerForm
              initial={server}
              message={state.kind === "server" ? state.message : ""}
              onClose={() => setEditingServer(false)}
            />
          ) : (
            <>
              {(state.kind === "starting" || state.kind === "checking" || clearing) && (
                <View style={{ gap: 20, paddingVertical: 48, alignItems: "center" }}>
                  <ActivityIndicator />
                  <Heading>{clearing ? "正在退出登录" : "正在验证身份"}</Heading>
                  <Copy muted>
                    {clearing ? "正在完成退出，请稍候。" : "验证后继续原来的任务。"}
                  </Copy>
                </View>
              )}
              {(state.kind === "signed-out" || state.kind === "logging-in") && (
                <LoginForm
                  key={server}
                  busy={state.kind === "logging-in"}
                  message={state.kind === "signed-out" ? state.message : ""}
                />
              )}
              {state.kind === "signed-in" && (
                <>
                  <Section>
                    <Row
                      title={state.human.displayName}
                      subtitle={`@${state.human.handle} · ${state.human.role === "admin" ? "管理员" : "普通人类"}`}
                      leading={<Avatar name={state.human.displayName} />}
                    />
                  </Section>
                  <Section title="当前连接">
                    <Row title="服务器" subtitle={server} />
                    <Row title="账号 ID" value={String(state.human.accountId)} />
                    <Row title="重新验证登录" onPress={() => void auth.revalidate()} />
                  </Section>
                </>
              )}
              {state.kind === "unavailable" && (
                <>
                  <Heading>暂时无法连接</Heading>
                  <ErrorLine text={state.message} />
                  <Button title="重试连接" primary onPress={() => void auth.retry()} />
                </>
              )}
              {server && !clearing && (
                <Section title={state.kind === "signed-in" ? "账号" : "服务器"}>
                  {state.kind !== "signed-in" && (
                    <Row title={new URL(server).host} subtitle={server} />
                  )}
                  <Row
                    title="更换服务器"
                    disabled={state.kind === "logging-in"}
                    onPress={() => setEditingServer(true)}
                  />
                </Section>
              )}
              {server &&
                (state.kind === "signed-in" ||
                  state.kind === "unavailable" ||
                  state.kind === "checking") && (
                  <ConfirmButton
                    title="退出登录"
                    question="退出当前登录？"
                    message="本次登录的聊天与创建草稿会清除。再次使用时需要重新登录。"
                    confirmLabel="退出登录"
                    danger
                    onConfirm={() => void auth.logout()}
                  />
                )}
              {state.kind === "signed-out" && (
                <Caption>密码只用于此次登录，不会保存在本机。</Caption>
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
  return state.kind === "signed-in" ? (
    content
  ) : (
    <PresentationAccess.Provider
      value={
        state.kind === "signed-out" ||
        state.kind === "server" ||
        state.kind === "unavailable" ||
        state.kind === "checking"
      }
    >
      {content}
    </PresentationAccess.Provider>
  );
}
