import { Stack, router } from "expo-router";
import { useHuman } from "../../../admin/session";
import { Button, Copy, Screen } from "../../../ui";
import { useTheme } from "../../../theme";
export const unstable_settings = { initialRouteName: "admin/agents/index" };
export default function AgentsLayout() {
  const c = useTheme();
  if (useHuman()?.role !== "admin")
    return (
      <Screen>
        <Copy>需要管理员权限。</Copy>
        <Button title="返回聊天" onPress={() => router.replace("/chat")} />
      </Screen>
    );
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
      <Stack.Screen
        name="admin/agents/index"
        options={{ title: "Agent", headerLargeTitle: true }}
      />
      <Stack.Screen name="admin/agents/create" options={{ title: "创建 Agent" }} />
      <Stack.Screen name="admin/agents/[id]" options={{ title: "Agent 详情" }} />
    </Stack>
  );
}
