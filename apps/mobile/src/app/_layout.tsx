import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { NotificationIntegration } from "../notifications-root";
import { useTheme } from "../theme";

export default function RootLayout() {
  const colors = useTheme();

  return (
    <>
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
        <Stack.Screen name="notifications" options={{ title: "通知" }} />
      </Stack>
    </>
  );
}
