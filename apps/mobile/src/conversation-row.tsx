import { t, numberText, listText } from "./i18n";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { ComponentProps } from "react";
import { Avatar } from "./ui";
import { useTheme } from "./theme";
export function ConversationRow({
  title,
  subtitle,
  time,
  count = 0,
  mentioned = false,
  kind,
  onPress,
}: {
  title: string;
  subtitle: string;
  /** When the conversation last had activity, already formatted. */
  time?: string;
  count?: number;
  mentioned?: boolean;
  kind: NonNullable<ComponentProps<typeof Avatar>["kind"]>;
  onPress(): void;
}) {
  const c = useTheme();
  const large = useWindowDimensions().fontScale >= 1.5;
  const metadata = count > 0 && (
    <View
      style={{
        borderRadius: 12,
        minWidth: 22,
        alignItems: "center",
        alignSelf: "flex-start",
        backgroundColor: mentioned ? c.accent : c.tint,
        paddingHorizontal: 7,
        paddingVertical: 2,
      }}
    >
      <Text style={{ color: mentioned ? c.background : c.accent, fontSize: 13, fontWeight: "600" }}>
        {numberText(count)}
      </Text>
    </View>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={listText(
        [
          title,
          time ?? "",
          subtitle,
          mentioned ? t("chat.mentioned_you") : "",
          count ? t("chat.unread_count", { count }) : "",
        ].filter(Boolean),
      )}
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
      <Avatar name={title} kind={kind} size={44} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              color: c.foreground,
              fontSize: 17,
              fontWeight: count ? "600" : "500",
            }}
          >
            {title}
          </Text>
          {!!time && <Text style={{ color: c.muted, fontSize: 13 }}>{time}</Text>}
        </View>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <Text numberOfLines={2} style={{ flex: 1, color: c.muted, fontSize: 15, lineHeight: 20 }}>
            {subtitle}
          </Text>
          {!large && metadata}
        </View>
        {large && metadata}
      </View>
    </Pressable>
  );
}
