import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useTheme } from "../theme";

export default function HomeScreen() {
  const colors = useTheme();

  return (
    <SafeAreaView style={styles.screen} edges={["left", "right", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.foreground }]}>
          移动客户端
        </Text>
        <Text style={[styles.description, { color: colors.muted }]}>
          和长期协作的 Agent 同事一起工作。
        </Text>
        <View style={[styles.card, { backgroundColor: colors.subtle, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>开发中</Text>
          <Text style={[styles.description, { color: colors.muted }]}>
            移动客户端尚未接入控制面。聊天、管理和通知功能请继续使用网页版 Mate。
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: {
    paddingHorizontal: 16,
    paddingVertical: 24,
    gap: 24,
    maxWidth: 576,
    width: "100%",
    alignSelf: "center",
  },
  title: { fontSize: 24, fontWeight: "600", letterSpacing: -0.5 },
  description: { fontSize: 14, lineHeight: 24 },
  card: { padding: 24, borderWidth: 1, borderRadius: 8, gap: 16 },
  cardTitle: { fontSize: 16, fontWeight: "600" },
});
