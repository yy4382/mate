import { router, Stack } from "expo-router";
import { useHuman } from "../../../admin/session";
import { Button, Copy, Screen } from "../../../admin/ui";
import { useTheme } from "../../../theme";

export default function AdminLayout() {
  const human = useHuman();
  const colors = useTheme();
  if (human?.role !== "admin")
    return (
      <Screen topInset>
        <Copy>需要管理员权限。</Copy>
        <Button title="返回首页" onPress={() => router.replace("/")} />
      </Screen>
    );
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.foreground,
        contentStyle: { backgroundColor: colors.background },
        headerBackTitle: "返回",
      }}
    >
      <Stack.Screen name="index" options={{ title: "管理" }} />
      <Stack.Screen name="agents/index" options={{ title: "Agent" }} />
      <Stack.Screen name="agents/create" options={{ title: "创建 Agent" }} />
      <Stack.Screen name="agents/[id]" options={{ title: "Agent 详情" }} />
      <Stack.Screen name="providers" options={{ title: "模型提供商" }} />
      <Stack.Screen name="nodes" options={{ title: "Node" }} />
      <Stack.Screen name="humans" options={{ title: "人类" }} />
    </Stack>
  );
}
