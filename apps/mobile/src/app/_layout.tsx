import { Session } from "../session";
import { AgentCreationProvider } from "../admin/creation";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthLifecycle } from "../lifecycle";
import { NotificationIntegration } from "../notifications-root";
import { useTheme } from "../theme";

export default function RootLayout() {
  const colors = useTheme();

  return (
    <Session>
      <AgentCreationProvider>
        <AuthLifecycle />
        <NotificationIntegration />
        <StatusBar style="auto" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.foreground,
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          <Stack.Screen name="index" options={{ title: "Mate" }} />
          <Stack.Screen name="(signed-in)" options={{ headerShown: false }} />
          <Stack.Screen name="(management)" options={{ headerShown: false }} />
          <Stack.Screen name="notifications" options={{ title: "通知", headerBackTitle: "返回" }} />
        </Stack>
      </AgentCreationProvider>
    </Session>
  );
}
