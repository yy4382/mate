import { t } from "../../i18n";
import { Redirect, usePathname } from "expo-router";
import { useSyncExternalStore } from "react";
import { StyleSheet, Text, View } from "react-native";
import { auth } from "../../auth-native";
import { useSessionChat } from "../../session";
import HomeScreen from "../index";
import { ManagementScope } from "../../admin/session";
import { NativeTabs } from "expo-router/native-tabs";
import { useHuman } from "../../admin/session";
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
        <Text style={{ color: c.foreground, fontSize: 17 }}>{t("common.loading_chats")}</Text>
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
        <ManagementScope>
          <Tabs />
        </ManagementScope>
      </View>
      {!ready && (
        <View style={StyleSheet.absoluteFill}>
          <HomeScreen account />
        </View>
      )}
    </View>
  );
}

function Tabs() {
  const c = useTheme();
  const human = useHuman();
  const pathname = usePathname();
  return (
    <NativeTabs tintColor={c.accent} hidden={!["/chat", "/agents", "/account"].includes(pathname)}>
      <NativeTabs.Trigger name="(chat)">
        <NativeTabs.Trigger.Label>{t("chat.chat")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{
            default: "bubble.left.and.bubble.right",
            selected: "bubble.left.and.bubble.right.fill",
          }}
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(agents)" hidden={human?.role !== "admin"}>
        <NativeTabs.Trigger.Label>{t("chat.agent")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="person.2" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(settings)">
        <NativeTabs.Trigger.Label>{t("management.settings")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
