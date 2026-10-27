import { Stack } from "expo-router";
import { useTheme } from "../../../theme";
export const unstable_settings = { initialRouteName: "chat" };
export default function ChatLayout() {
  const c = useTheme();
  return (
    <Stack
      screenOptions={{
        headerTintColor: c.accent,
        headerTitleStyle: { color: c.foreground },
        headerLargeTitleStyle: { color: c.foreground },
        contentStyle: { backgroundColor: c.background },
        headerShadowVisible: false,
        headerBackButtonDisplayMode: "minimal",
      }}
    >
      <Stack.Screen name="chat" options={{ title: "聊天", headerLargeTitle: true }} />
      <Stack.Screen name="conversation" options={{ title: "会话" }} />
      <Stack.Screen name="search" options={{ title: "搜索消息" }} />
      <Stack.Screen name="new" options={{ headerShown: false, animation: "none" }} />
      <Stack.Screen name="channels" options={{ title: "浏览频道" }} />
    </Stack>
  );
}
