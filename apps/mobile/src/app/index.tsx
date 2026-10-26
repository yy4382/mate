import { useRef, useState, useSyncExternalStore, type ComponentRef } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { auth } from "../auth-native";
import { useTheme } from "../theme";

function Button({
  title,
  onPress,
  disabled = false,
  secondary = false,
}: {
  title: string;
  onPress(): void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  const colors = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: secondary ? colors.background : colors.foreground,
          borderColor: colors.border,
          opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
        },
      ]}
    >
      <Text
        style={[styles.buttonText, { color: secondary ? colors.foreground : colors.background }]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

function ServerForm({
  initial,
  message,
  onClose,
  onCancel,
}: {
  initial: string;
  message: string;
  onClose(): void;
  onCancel?: () => void;
}) {
  const colors = useTheme();
  const [address, setAddress] = useState(initial);
  const save = async () => {
    Keyboard.dismiss();
    await auth.changeServer(address);
    if (auth.getSnapshot().kind !== "server") onClose();
  };
  return (
    <>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]}>
        连接服务器
      </Text>
      <Text style={[styles.description, { color: colors.muted }]}>
        输入你使用的 Mate 服务器地址。此设备只保存一个地址，更换后需要重新登录。
      </Text>
      <Text style={[styles.label, { color: colors.foreground }]}>服务器地址</Text>
      <TextInput
        accessibilityLabel="服务器地址"
        testID="server-address"
        value={address}
        onChangeText={setAddress}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        textContentType="URL"
        placeholder="https://mate.example.com"
        placeholderTextColor={colors.muted}
        returnKeyType="go"
        onSubmitEditing={() => void save()}
        style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
      />
      <Message text={message} />
      <Button title="保存服务器" disabled={!address.trim()} onPress={() => void save()} />
      {onCancel && <Button title="取消" secondary onPress={onCancel} />}
    </>
  );
}

function LoginForm({ busy, message }: { busy: boolean; message: string }) {
  const colors = useTheme();
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const passwordField = useRef<ComponentRef<typeof TextInput>>(null);
  const submit = () => {
    if (busy || !handle.trim() || !password) return;
    Keyboard.dismiss();
    void auth.login(handle.trim(), password);
    setPassword("");
  };
  return (
    <>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]}>
        登录 Mate
      </Text>
      <Text style={[styles.label, { color: colors.foreground }]}>Handle</Text>
      <TextInput
        accessibilityLabel="Handle"
        testID="login-handle"
        value={handle}
        onChangeText={setHandle}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="username"
        returnKeyType="next"
        onSubmitEditing={() => passwordField.current?.focus()}
        submitBehavior="submit"
        style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
      />
      <Text style={[styles.label, { color: colors.foreground }]}>密码</Text>
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
        style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
      />
      <Message text={message} />
      <Button
        title={busy ? "正在登录…" : "登录"}
        disabled={busy || !handle.trim() || !password}
        onPress={submit}
      />
    </>
  );
}

function Message({ text }: { text: string }) {
  const colors = useTheme();
  return text ? (
    <Text accessibilityRole="alert" style={[styles.description, { color: colors.foreground }]}>
      {text}
    </Text>
  ) : null;
}

export default function HomeScreen() {
  const colors = useTheme();
  const state = useSyncExternalStore(auth.subscribe, auth.getSnapshot);
  const [editingServer, setEditingServer] = useState(false);
  const server = "server" in state ? state.server : "";
  const clearing = state.kind === "clearing";

  return (
    <SafeAreaView style={styles.screen} edges={["left", "right", "bottom"]}>
      <KeyboardAvoidingView style={styles.screen} behavior="padding" keyboardVerticalOffset={100}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={styles.content}
        >
          <View
            style={[styles.card, { backgroundColor: colors.subtle, borderColor: colors.border }]}
          >
            {(editingServer || state.kind === "server") && !clearing ? (
              <ServerForm
                initial={server}
                message={state.kind === "server" ? state.message : ""}
                onClose={() => setEditingServer(false)}
                {...(server ? { onCancel: () => setEditingServer(false) } : {})}
              />
            ) : (
              <>
                {(state.kind === "starting" || state.kind === "checking" || clearing) && (
                  <Message text={clearing ? "正在清理本机登录…" : "正在验证登录…"} />
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
                    <Text
                      accessibilityRole="header"
                      style={[styles.title, { color: colors.foreground }]}
                    >
                      当前身份
                    </Text>
                    <Text selectable style={[styles.identity, { color: colors.foreground }]}>
                      {state.human.displayName}
                    </Text>
                    <Text selectable style={[styles.description, { color: colors.foreground }]}>
                      Handle：{state.human.handle}
                    </Text>
                    <Text style={[styles.description, { color: colors.foreground }]}>
                      角色：{state.human.role === "admin" ? "管理员" : "普通人类"}
                    </Text>
                    <Text style={[styles.description, { color: colors.muted }]}>
                      账号 ID：{state.human.accountId} · {state.human.active ? "有效" : "已停用"}
                    </Text>
                    <Button title="重新验证登录" secondary onPress={() => void auth.revalidate()} />
                    <Button title="个人资料" onPress={() => router.push("/profile")} />
                    {state.human.role === "admin" && (
                      <Button title="管理" onPress={() => router.push("/admin")} />
                    )}
                  </>
                )}
                {state.kind === "unavailable" && (
                  <>
                    <Message text={state.message} />
                    <Button title="重试连接" onPress={() => void auth.retry()} />
                  </>
                )}
                {server && (
                  <>
                    <Text selectable style={[styles.description, { color: colors.muted }]}>
                      {server}
                    </Text>
                    <Button
                      title="更换服务器"
                      secondary
                      disabled={clearing}
                      onPress={() => setEditingServer(true)}
                    />
                    {(state.kind === "signed-in" ||
                      state.kind === "unavailable" ||
                      state.kind === "checking") && (
                      <Button
                        title="退出登录"
                        secondary
                        disabled={clearing}
                        onPress={() => void auth.logout()}
                      />
                    )}
                  </>
                )}
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: {
    paddingHorizontal: 16,
    paddingVertical: 24,
    maxWidth: 576,
    width: "100%",
    alignSelf: "center",
  },
  card: { padding: 24, borderWidth: 1, borderRadius: 8, gap: 16 },
  title: { fontSize: 24, fontWeight: "600" },
  identity: { fontSize: 22, fontWeight: "600" },
  description: { fontSize: 16, flexShrink: 1 },
  label: { fontSize: 16, fontWeight: "500" },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 6, padding: 12, fontSize: 17 },
  button: {
    minHeight: 48,
    padding: 12,
    borderWidth: 1,
    borderRadius: 6,
    justifyContent: "center",
    alignItems: "center",
  },
  buttonText: { fontSize: 17, fontWeight: "600", textAlign: "center" },
});
