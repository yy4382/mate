import { t } from "../../../i18n";
import { Stack, router } from "expo-router";
import { useHuman } from "../../../admin/session";
import { Button, Copy, Screen } from "../../../ui";
import { useTheme } from "../../../theme";
export const unstable_settings = { initialRouteName: "agents/index" };
export default function AgentsLayout() {
  const c = useTheme();
  if (useHuman()?.role !== "admin")
    return (
      <Screen>
        <Copy>{t("management.administrator_access_required")}</Copy>
        <Button title={t("chat.back_to_chat")} onPress={() => router.replace("/chat")} />
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
        name="agents/index"
        options={{ title: t("chat.agent"), headerLargeTitle: true }}
      />
      <Stack.Screen name="agents/create" options={{ title: t("management.create_agent") }} />
      <Stack.Screen name="agents/[id]" options={{ title: t("chat.agent") }} />
      <Stack.Screen name="agents/[id]/settings" options={{ title: t("management.settings") }} />
      <Stack.Screen name="agents/[id]/access" options={{ title: t("management.node_access") }} />
      <Stack.Screen name="agents/[id]/usage" options={{ title: t("management.usage") }} />
      <Stack.Screen name="agents/[id]/workspace" options={{ title: t("management.workspace") }} />
      <Stack.Screen name="agents/prerequisites/nodes" options={{ title: t("common.node") }} />
      <Stack.Screen
        name="agents/prerequisites/providers"
        options={{ title: t("management.provider") }}
      />
      <Stack.Screen
        name="agents/prerequisites/providers/[provider]"
        options={{ title: t("management.provider") }}
      />
      <Stack.Screen
        name="agents/prerequisites/providers/catalog"
        options={{ title: t("management.model_catalog") }}
      />
      <Stack.Screen name="agents/prerequisites/nodes/[id]" options={{ title: t("common.node") }} />
    </Stack>
  );
}
