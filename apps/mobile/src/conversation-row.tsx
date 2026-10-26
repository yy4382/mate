import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { ComponentProps } from "react";
import { Avatar, Caption } from "./ui";
import { useTheme } from "./theme";
export function ConversationRow({
  title,
  subtitle,
  count = 0,
  mentioned = false,
  kind,
  onPress,
  testID,
}: {
  title: string;
  subtitle: string;
  count?: number;
  mentioned?: boolean;
  kind: NonNullable<ComponentProps<typeof Avatar>["kind"]>;
  onPress(): void;
  testID?: string;
}) {
  const c = useTheme();
  const large = useWindowDimensions().fontScale >= 1.5;
  const metadata = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {mentioned && <Text style={{ fontSize: 12, color: c.accent }}>提及你</Text>}
      {count > 0 && (
        <View
          style={{
            borderRadius: 12,
            backgroundColor: c.tint,
            paddingHorizontal: 7,
            paddingVertical: 2,
          }}
        >
          <Text style={{ color: c.accent, fontSize: 13, fontWeight: "600" }}>{count}</Text>
        </View>
      )}
    </View>
  );
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${title}，${subtitle}${mentioned ? "，提及你" : ""}${count ? `，${count} 条未读` : ""}`}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 68,
        paddingVertical: 12,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderColor: c.border,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Avatar name={title} kind={kind} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ color: c.foreground, fontSize: 17, fontWeight: count ? "600" : "500" }}>
          {title}
        </Text>
        <Caption>{subtitle}</Caption>
        {large && metadata}
      </View>
      {!large && metadata}
    </Pressable>
  );
}
