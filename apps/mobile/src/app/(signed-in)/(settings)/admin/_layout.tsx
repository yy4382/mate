import { t } from "../../../../i18n";
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
        <Copy>{t("management.administrator_access_required")}</Copy>
        <Button
          title={t("management.back_to_settings")}
          onPress={() => router.replace("/account")}
        />
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
      <Stack.Screen name="index" options={{ title: t("management.manage_mate") }} />
      <Stack.Screen name="providers/[provider]" options={{ title: t("management.provider") }} />
      <Stack.Screen name="providers/catalog" options={{ title: t("management.model_catalog") }} />
      <Stack.Screen name="nodes/[id]" options={{ title: t("management.node_details") }} />
      <Stack.Screen name="humans/[id]" options={{ title: t("management.human_details") }} />
      <Stack.Screen name="providers" options={{ title: t("management.model_providers") }} />
      <Stack.Screen name="nodes" options={{ title: t("common.node") }} />
      <Stack.Screen name="humans" options={{ title: t("chat.human") }} />
    </Stack>
  );
}
