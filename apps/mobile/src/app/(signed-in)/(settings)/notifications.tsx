import { useSyncExternalStore } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { notifications } from "../../../notifications-native";
import { useTheme } from "../../../theme";

export default function NotificationSettings() {
  const colors = useTheme();
  const state = useSyncExternalStore(notifications.subscribe, notifications.getSnapshot);
  const disabled = state.kind === "signed-out" || state.kind === "checking";
  const button = (label: string, action: () => void, primary = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={action}
      style={({ pressed }) => [
        styles.button,
        {
          borderColor: colors.border,
          backgroundColor: primary ? colors.foreground : colors.background,
          opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
        },
      ]}
    >
      <Text style={[styles.buttonText, { color: primary ? colors.background : colors.foreground }]}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <SafeAreaView style={styles.screen} edges={["left", "right", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]}>
          通知
        </Text>
        <Text style={[styles.text, { color: colors.muted }]}>
          仅通知发给你的私信和提及，不显示消息正文。点击通知会打开对应的会话或讨论串。
        </Text>
        <Text
          accessibilityRole="alert"
          testID="notification-status"
          style={[styles.text, { color: colors.foreground }]}
        >
          {state.message}
        </Text>
        {state.kind !== "enabled" && button("开启通知", () => void notifications.enable(), true)}
        {button("关闭通知", () => void notifications.disable())}
        {button("重新检查", () => void notifications.refresh())}
        {button("打开 iOS 设置", () => {
          void Linking.openSettings();
        })}
        <Text style={[styles.text, { color: colors.muted }]}>
          系统权限与服务器登记都完成后才能接收远程通知。专注模式和系统设置可能影响提示。
        </Text>
        <Text style={[styles.text, { color: colors.muted }]}>
          退出登录或更换服务器时会取消登记并关闭本机推送。离线时无法保证旧服务器立即停止发送；取消未确认时会提示。旧通知不能打开其他账号或服务器的会话。
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 24, gap: 16, maxWidth: 576, width: "100%", alignSelf: "center" },
  title: { fontSize: 24, fontWeight: "600" },
  text: { fontSize: 16, lineHeight: 24 },
  button: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 6,
    padding: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: 17, fontWeight: "600", textAlign: "center" },
});
