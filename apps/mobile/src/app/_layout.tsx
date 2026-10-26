import { useEffect } from "react";
import { AppState } from "react-native";
import { focusManager } from "@tanstack/react-query";
import { auth } from "../auth-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useTheme } from "../theme";

export default function RootLayout() {
  const colors = useTheme();
  useEffect(() => {
    void auth.start();
    const subscription = AppState.addEventListener("change", (next) => {
      focusManager.setFocused(next === "active");
      if (next === "active") void auth.revalidate();
    });
    return () => subscription.remove();
  }, []);

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
