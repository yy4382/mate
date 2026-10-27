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
      <Stack.Screen name="admin/agents/[id]" options={{ title: "Agent" }} />
      <Stack.Screen name="admin/agents/[id]/settings" options={{ title: "设置" }} />
      <Stack.Screen name="admin/agents/[id]/access" options={{ title: "Node 访问" }} />
      <Stack.Screen name="admin/agents/[id]/usage" options={{ title: "用量" }} />
      <Stack.Screen name="admin/agents/[id]/workspace" options={{ title: "工作区" }} />
      <Stack.Screen name="admin/agents/prerequisites/nodes" options={{ title: "Node" }} />
      <Stack.Screen name="admin/agents/prerequisites/providers" options={{ title: "提供商" }} />
    </Stack>
  );
}
