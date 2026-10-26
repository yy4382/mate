import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import type { AccountView } from "@mate/chat/contracts";
import type { Draft } from "./chat";
import { Button, Caption, ErrorLine, Field, styles } from "./ui";
import { useTheme } from "./theme";
export function ChatComposer({
  draft,
  accounts,
  inThread,
  onEdit,
  onSend,
  onAbandon,
  onFocusChange,
}: {
  draft: Draft;
  accounts: readonly AccountView[];
  inThread: boolean;
  onEdit(text: string): void;
  onSend(): void;
  onAbandon(): void;
  onFocusChange(focused: boolean): void;
}) {
  const c = useTheme();
  const dimensions = useWindowDimensions();
  return (
    <View
      testID="message-composer-panel"
      style={{
        paddingHorizontal: 16,
        paddingVertical: 8,
        gap: 6,
        borderTopWidth: 1,
        borderColor: c.border,
        backgroundColor: c.background,
      }}
    >
      {/@[\p{L}\p{N}_.-]*$/u.test(draft.text) && (
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: 8 }}
        >
          {accounts
            .filter(
              (a) =>
                a.active &&
                a.handle
                  .toLowerCase()
                  .startsWith((draft.text.match(/@([\p{L}\p{N}_.-]*)$/u)?.[1] ?? "").toLowerCase()),
            )
            .slice(0, 5)
            .map((a) => (
              <Pressable
                key={a.accountId}
                accessibilityRole="button"
                accessibilityLabel={`提及 ${a.displayName} @${a.handle}`}
                onPress={() => onEdit(draft.text.replace(/@[\p{L}\p{N}_.-]*$/u, `@${a.handle} `))}
                style={{ padding: 10, minHeight: 44, gap: 2 }}
              >
                <Text style={{ fontSize: 15, color: c.accent }}>{a.displayName}</Text>
                <Caption>
                  @{a.handle} · {a.kind === "agent" ? "Agent" : "人类"}
                </Caption>
              </Pressable>
            ))}
        </ScrollView>
      )}
      {(draft.error || draft.pending?.status === "failed") && (
        <ScrollView
          style={{ maxHeight: dimensions.height * 0.24 }}
          keyboardShouldPersistTaps="handled"
        >
          {draft.pending?.status === "failed" && (
            <>
              <Caption>发送结果尚未确认</Caption>
              <Text numberOfLines={2} style={{ fontSize: 15, color: c.muted }}>
                {draft.pending.text}
              </Text>
            </>
          )}
          <ErrorLine text={draft.error} />
          {draft.pending?.status === "failed" && (
            <View style={styles.row}>
              <Button title="重试发送" onPress={onSend} />
              <Button title="取消本次发送" onPress={onAbandon} />
            </View>
          )}
        </ScrollView>
      )}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Field
            testID="message-composer"
            accessibilityLabel="消息"
            placeholder={!inThread ? "发送消息…" : "回复讨论串…"}
            multiline
            value={draft.text}
            onChangeText={(text) => onEdit(text)}
            onFocus={() => onFocusChange(true)}
            onBlur={() => onFocusChange(false)}
            style={{
              minHeight: 44,
              maxHeight: Math.min(160, dimensions.height * 0.24),
              borderRadius: 20,
              textAlignVertical: "top",
              paddingHorizontal: 14,
            }}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={draft.pending?.status === "failed" ? "重试发送" : "发送"}
          disabled={draft.pending?.status === "sending" || (!draft.pending && !draft.text.trim())}
          onPress={onSend}
          style={({ pressed }) => ({
            width: 48,
            minHeight: 48,
            borderRadius: 24,
            backgroundColor: c.accent,
            alignItems: "center",
            justifyContent: "center",
            opacity:
              draft.pending?.status === "sending" || (!draft.pending && !draft.text.trim())
                ? 0.4
                : pressed
                  ? 0.6
                  : 1,
          })}
        >
          <Text
            allowFontScaling={false}
            style={{ fontSize: 24, color: c.background, fontWeight: "600" }}
          >
            ↑
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
