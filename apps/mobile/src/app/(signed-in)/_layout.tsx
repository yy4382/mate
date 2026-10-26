import { Redirect, Stack } from "expo-router";
import { useSyncExternalStore } from "react";
import { StyleSheet, Text, View } from "react-native";
import { auth } from "../../auth-native";
import { useSessionChat } from "../../session";
import HomeScreen from "../index";
import { useTheme } from "../../theme";
export default function SignedInLayout() {
  const state = useSyncExternalStore(auth.subscribe, auth.getSnapshot);
  const chat = useSessionChat();
  const c = useTheme();
  if (!chat) {
    if (state.kind === "starting" || state.kind === "checking") return <HomeScreen account />;
    if (state.kind !== "signed-in") return <Redirect href="/" />;
    return (
      <View style={{ flex: 1, padding: 16 }}>
        <Text style={{ color: c.foreground, fontSize: 17 }}>正在加载聊天…</Text>
      </View>
    );
  }
  const ready = state.kind === "signed-in";
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{ flex: 1, opacity: ready ? 1 : 0 }}
        pointerEvents={ready ? "auto" : "none"}
        accessibilityElementsHidden={!ready}
        importantForAccessibility={ready ? "auto" : "no-hide-descendants"}
      >
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: c.background },
            headerTintColor: c.foreground,
            contentStyle: { backgroundColor: c.background },
            headerShadowVisible: false,
            headerBackButtonDisplayMode: "minimal",
          }}
        >
          <Stack.Screen name="chat" options={{ title: "聊天", headerBackVisible: false }} />
          <Stack.Screen name="conversation" options={{ title: "会话" }} />
          <Stack.Screen name="search" options={{ title: "搜索消息" }} />
          <Stack.Screen name="new" options={{ title: "新建会话", presentation: "modal" }} />
          <Stack.Screen name="account" options={{ title: "账号与服务器" }} />
        </Stack>
      </View>
      {!ready && (
        <View style={StyleSheet.absoluteFill}>
          <HomeScreen account />
        </View>
      )}
    </View>
  );
}
