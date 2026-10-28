import { t } from "../../../i18n";
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
      <Stack.Screen
        name="account"
        options={{ title: t("management.settings"), headerLargeTitle: true }}
      />
      <Stack.Screen name="connection" options={{ title: t("settings.account_and_connection") }} />
      <Stack.Screen name="profile" options={{ title: t("management.profile") }} />
      <Stack.Screen name="profile-edit" options={{ title: t("settings.edit_profile") }} />
      <Stack.Screen name="password" options={{ title: t("settings.change_password") }} />
      <Stack.Screen name="notifications" options={{ title: t("settings.notifications") }} />
      <Stack.Screen name="admin" options={{ headerShown: false }} />
    </Stack>
  );
}
