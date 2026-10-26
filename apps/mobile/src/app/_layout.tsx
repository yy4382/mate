import { Session } from "../session";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useTheme } from "../theme";

export default function RootLayout() {
  const colors = useTheme();

  return (
    <Session>
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
      </Stack>
    </Session>
  );
}
