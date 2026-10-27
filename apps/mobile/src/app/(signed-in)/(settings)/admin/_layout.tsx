import { router, Stack } from "expo-router";
import { useHuman } from "../../../../admin/session";
import { Button, Copy, Screen } from "../../../../admin/ui";
import { useTheme } from "../../../../theme";

export default function AdminLayout() {
  const human = useHuman();
  const colors = useTheme();
  if (human?.role !== "admin")
    return (
      <Screen topInset>
        <Copy>需要管理员权限。</Copy>
        <Button title="返回设置" onPress={() => router.replace("/account")} />
      </Screen>
    );
  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.accent,
        contentStyle: { backgroundColor: colors.grouped },
        headerBackButtonDisplayMode: "minimal",
        headerShadowVisible: false,
        headerTitleStyle: { color: colors.foreground },
      }}
    >
      <Stack.Screen name="index" options={{ title: "管理 Mate" }} />
      <Stack.Screen name="agents/index" options={{ headerShown: false }} />
      <Stack.Screen name="agents/create" options={{ headerShown: false }} />
      <Stack.Screen name="agents/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="providers/[provider]" options={{ title: "提供商" }} />
      <Stack.Screen name="providers/catalog" options={{ title: "模型目录" }} />
      <Stack.Screen name="nodes/[id]" options={{ title: "Node 详情" }} />
      <Stack.Screen name="humans/[id]" options={{ title: "人类详情" }} />
      <Stack.Screen name="providers" options={{ title: "模型提供商" }} />
      <Stack.Screen name="nodes" options={{ title: "Node" }} />
      <Stack.Screen name="humans" options={{ title: "人类" }} />
    </Stack>
  );
}
