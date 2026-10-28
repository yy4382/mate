import { t } from "../i18n";
import { Session } from "../session";
import { AgentCreationProvider } from "../admin/creation";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { useColorScheme } from "react-native";
import { StatusBar } from "expo-status-bar";
import { AuthLifecycle } from "../lifecycle";
import { NotificationIntegration } from "../notifications-root";
import { useTheme } from "../theme";

export default function RootLayout() {
  const colors = useTheme();
  const navigationTheme = useColorScheme() === "dark" ? DarkTheme : DefaultTheme;

  return (
    <ThemeProvider
      value={{
        ...navigationTheme,
        colors: {
          ...navigationTheme.colors,
          primary: colors.accent,
          background: colors.background,
          card: colors.surface,
          text: colors.foreground,
          border: colors.border,
          notification: colors.accent,
        },
      }}
    >
      <Session>
        <AgentCreationProvider>
          <AuthLifecycle />
          <NotificationIntegration />
          <StatusBar style="auto" />
          <Stack
            screenOptions={{
              headerTintColor: colors.foreground,
              headerShadowVisible: false,
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            <Stack.Screen name="index" options={{ title: t("common.app_name") }} />
            <Stack.Screen name="(signed-in)" options={{ headerShown: false }} />
          </Stack>
        </AgentCreationProvider>
      </Session>
    </ThemeProvider>
  );
}
