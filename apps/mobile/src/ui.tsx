import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { useTheme } from "./theme";
export function Button({
  title,
  onPress,
  disabled = false,
  primary = false,
  testID,
}: {
  title: string;
  onPress(): void;
  disabled?: boolean;
  primary?: boolean;
  testID?: string;
}) {
  const c = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: primary ? c.foreground : c.background,
          borderColor: c.border,
          opacity: disabled ? 0.4 : pressed ? 0.65 : 1,
        },
      ]}
    >
      <Text
        style={{
          fontSize: 16,
          fontWeight: "600",
          color: primary ? c.background : c.foreground,
          textAlign: "center",
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}
export function Label({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  const c = useTheme();
  return (
    <Text style={{ fontSize: 16, color: muted ? c.muted : c.foreground, flexShrink: 1 }}>
      {children}
    </Text>
  );
}
export function Heading({ children }: { children: ReactNode }) {
  const c = useTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{ fontSize: 22, fontWeight: "600", color: c.foreground }}
    >
      {children}
    </Text>
  );
}
export function Field(props: TextInputProps) {
  const c = useTheme();
  return (
    <TextInput
      {...props}
      placeholderTextColor={c.muted}
      style={[styles.input, { color: c.foreground, borderColor: c.border }, props.style]}
    />
  );
}
export function ErrorLine({ text }: { text: string }) {
  const c = useTheme();
  return text ? (
    <Text
      accessibilityRole="alert"
      style={{ fontSize: 16, color: c.foreground, paddingVertical: 8 }}
    >
      {text}
    </Text>
  ) : null;
}
export function Card({ children }: { children: ReactNode }) {
  const c = useTheme();
  return (
    <View
      style={{
        padding: 16,
        gap: 12,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 8,
        backgroundColor: c.subtle,
      }}
    >
      {children}
    </View>
  );
}
export const styles = StyleSheet.create({
  button: { minHeight: 48, padding: 12, borderWidth: 1, borderRadius: 6, justifyContent: "center" },
  input: { minHeight: 48, padding: 12, borderWidth: 1, borderRadius: 6, fontSize: 17 },
  page: { padding: 16, gap: 16 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  fill: { flex: 1 },
  muted: { fontSize: 14 },
});
