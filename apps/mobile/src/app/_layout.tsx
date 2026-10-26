import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useTheme } from "../theme";

export default function RootLayout() {
  const colors = useTheme();

  return (
    <>
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
        <Stack.Screen name="(management)" options={{ headerShown: false }} />
      </Stack>
    </>
  );
}
