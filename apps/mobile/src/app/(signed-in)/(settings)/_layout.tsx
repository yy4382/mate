import { Stack } from "expo-router";
import { useTheme } from "../../../theme";
export const unstable_settings = { initialRouteName: "account" };
export default function SettingsLayout() {
  const c = useTheme();
  return (
    <Stack
      screenOptions={{
        headerTintColor: c.accent,
        headerTitleStyle: { color: c.foreground },
        headerLargeTitleStyle: { color: c.foreground },
        contentStyle: { backgroundColor: c.grouped },
        headerBackButtonDisplayMode: "minimal",
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="account" options={{ title: "设置", headerLargeTitle: true }} />
      <Stack.Screen name="connection" options={{ title: "账号与连接" }} />
      <Stack.Screen name="profile" options={{ title: "个人资料" }} />
      <Stack.Screen name="notifications" options={{ title: "通知" }} />
      <Stack.Screen name="admin" options={{ headerShown: false }} />
    </Stack>
  );
}
