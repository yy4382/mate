import { createContext, useContext, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type TextInputProps,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useIsFocused } from "expo-router";
import { useTheme, type as typography } from "./theme";

export const PresentationAccess = createContext(false);
export function Copy({
  children,
  muted = false,
  title = false,
  mono = false,
}: {
  children: ReactNode;
  muted?: boolean;
  title?: boolean;
  mono?: boolean;
}) {
  const c = useTheme();
  return (
    <Text
      selectable
      accessibilityRole={title ? "header" : undefined}
      style={[
        title ? typography.title : typography.body,
        { color: muted ? c.muted : c.foreground, flexShrink: 1 },
        mono && { fontFamily: "Menlo", fontSize: 13, lineHeight: 21 },
      ]}
    >
      {children}
    </Text>
  );
}
export function Label({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <Copy muted={muted}>{children}</Copy>;
}
export function Heading({ children }: { children: ReactNode }) {
  return <Copy title>{children}</Copy>;
}
export function Caption({ children, accent = false }: { children: ReactNode; accent?: boolean }) {
  const c = useTheme();
  return (
    <Text style={[typography.caption, { color: accent ? c.accent : c.muted, flexShrink: 1 }]}>
      {children}
    </Text>
  );
}
export function Screen({
  children,
  onRefresh,
  refreshing = false,
  topInset = false,
  grouped = true,
}: {
  children: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  topInset?: boolean;
  grouped?: boolean;
}) {
  const c = useTheme();
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: grouped ? c.grouped : c.background }}
      edges={topInset ? ["top", "left", "right", "bottom"] : ["left", "right"]}
    >
      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined
        }
        contentContainerStyle={styles.page}
      >
        {children}
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}
export function Card({ children }: { children: ReactNode }) {
  const c = useTheme();
  return (
    <View style={{ backgroundColor: c.surface, borderRadius: 14, padding: 16, gap: 12 }}>
      {children}
    </View>
  );
}
export function Section({
  title,
  children,
  footer,
}: {
  title?: string;
  children: ReactNode;
  footer?: string;
}) {
  const c = useTheme();
  return (
    <View style={{ gap: 8 }}>
      {title && (
        <Text
          accessibilityRole="header"
          style={[typography.caption, { color: c.muted, paddingHorizontal: 16 }]}
        >
          {title}
        </Text>
      )}
      <View style={{ borderRadius: 14, backgroundColor: c.surface, overflow: "hidden" }}>
        {children}
      </View>
      {footer && (
        <View style={{ paddingHorizontal: 16 }}>
          <Caption>{footer}</Caption>
        </View>
      )}
    </View>
  );
}
export function Button({
  title,
  onPress,
  disabled = false,
  primary = false,
  danger = false,
  testID,
}: {
  title: string;
  onPress(): void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
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
        {
          minHeight: 48,
          paddingHorizontal: 16,
          paddingVertical: 12,
          justifyContent: "center",
          borderRadius: 12,
          backgroundColor: primary ? (danger ? c.danger : c.accent) : "transparent",
          opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
        },
      ]}
    >
      <Text
        style={{
          fontSize: 17,
          fontWeight: "600",
          color: primary ? c.background : danger ? c.danger : c.accent,
          textAlign: "center",
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}
export function Row({
  title,
  subtitle,
  value,
  leading,
  onPress,
  selected,
  danger = false,
  disabled = false,
  testID,
  accessibilityLabel,
}: {
  title: string;
  subtitle?: string;
  value?: string;
  leading?: ReactNode;
  onPress?: () => void;
  selected?: boolean;
  danger?: boolean;
  disabled?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const c = useTheme();
  const large = useWindowDimensions().fontScale >= 1.5;
  const content = (
    <>
      {leading}
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ fontSize: 17, color: danger ? c.danger : c.foreground }}>{title}</Text>
        {subtitle && <Caption>{subtitle}</Caption>}
        {large && value && <Caption>{value}</Caption>}
      </View>
      {!large && value && (
        <Text
          style={{
            fontSize: 16,
            color: c.muted,
            maxWidth: "48%",
            textAlign: "right",
            flexShrink: 1,
          }}
        >
          {value}
        </Text>
      )}
      {selected !== undefined ? (
        <Text accessibilityElementsHidden style={{ color: c.accent, fontSize: 20, width: 24 }}>
          {selected ? "✓" : ""}
        </Text>
      ) : onPress ? (
        <Text accessibilityElementsHidden style={{ color: c.muted, fontSize: 20 }}>
          ›
        </Text>
      ) : null}
    </>
  );
  const rowStyle = {
    minHeight: 54,
    paddingVertical: 13,
    paddingHorizontal: 16,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
  };
  return onPress ? (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, ...(selected !== undefined ? { selected } : {}) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [rowStyle, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}
    >
      {content}
    </Pressable>
  ) : (
    <View style={rowStyle}>{content}</View>
  );
}
export function Avatar({
  name,
  kind = "human",
  size = 36,
}: {
  name: string;
  kind?: "human" | "agent" | "public" | "private" | "thread";
  size?: number;
}) {
  const c = useTheme();
  const mark =
    kind === "public"
      ? "#"
      : kind === "private"
        ? "私"
        : kind === "thread"
          ? "↳"
          : name.slice(0, 1).toLocaleUpperCase();
  return (
    <View
      accessibilityElementsHidden
      style={{
        width: size,
        height: size,
        borderRadius: kind === "human" ? size / 2 : 11,
        backgroundColor: c.tint,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: c.accent, fontWeight: "600", fontSize: size * 0.48 }}>{mark}</Text>
    </View>
  );
}
export function Field({
  label,
  hint,
  error,
  ...props
}: TextInputProps & { label?: string; hint?: string; error?: string }) {
  const c = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {label && <Text style={{ fontSize: 15, fontWeight: "500", color: c.muted }}>{label}</Text>}
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={c.muted}
        selectionColor={c.accent}
        autoCapitalize="none"
        autoCorrect={false}
        {...props}
        style={[
          styles.input,
          {
            color: c.foreground,
            backgroundColor: c.subtle,
            borderColor: error ? c.danger : "transparent",
          },
          props.multiline && { minHeight: 112, textAlignVertical: "top" },
          props.style,
        ]}
      />
      {hint && <Caption>{hint}</Caption>}
      {error && <ErrorLine text={error} />}
    </View>
  );
}
export function ErrorLine({ text }: { text: string }) {
  const c = useTheme();
  return text ? (
    <Text
      selectable
      accessibilityRole="alert"
      style={{ fontSize: 15, lineHeight: 23, color: c.danger }}
    >
      {text}
    </Text>
  ) : null;
}
export function Empty({
  title,
  message,
  children,
}: {
  title: string;
  message?: string;
  children?: ReactNode;
}) {
  return (
    <View style={{ paddingHorizontal: 24, paddingVertical: 40, gap: 12, alignItems: "center" }}>
      <Heading>{title}</Heading>
      {message && <Copy muted>{message}</Copy>}
      {children}
    </View>
  );
}
export function Sheet({
  title,
  onClose,
  children,
  visible = true,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  visible?: boolean;
}) {
  const ready = useContext(PresentationAccess);
  const focused = useIsFocused();
  const c = useTheme();
  return (
    <Modal
      visible={visible && ready && focused}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: c.grouped }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderColor: c.border,
          }}
        >
          <View style={{ flex: 1, paddingLeft: 12 }}>
            <Text
              accessibilityRole="header"
              style={{ fontSize: 17, fontWeight: "600", color: c.foreground }}
            >
              {title}
            </Text>
          </View>
          <Button title="关闭" onPress={onClose} />
        </View>
        <KeyboardAwareScrollView
          bottomOffset={24}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.page}
        >
          {children}
        </KeyboardAwareScrollView>
      </SafeAreaView>
    </Modal>
  );
}
export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange(value: string): void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = options.filter((o) =>
    o.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <>
      <Row
        title={label}
        value={options.find((o) => o.value === value)?.label ?? "请选择"}
        onPress={() => setOpen(true)}
        disabled={disabled}
      />
      <Sheet visible={open} title={label} onClose={() => setOpen(false)}>
        {options.length > 8 && (
          <Field
            label="搜索选项"
            value={query}
            onChangeText={setQuery}
            clearButtonMode="while-editing"
          />
        )}
        <Section>
          {filtered.map((o) => (
            <Row
              key={o.value}
              title={o.label}
              selected={o.value === value}
              onPress={() => {
                onChange(o.value);
                setOpen(false);
              }}
            />
          ))}
        </Section>
        {filtered.length === 0 && <Empty title="没有匹配选项" message="换一个关键词试试。" />}
        <Button title="取消选择" onPress={() => setOpen(false)} />
      </Sheet>
    </>
  );
}
export function ConfirmButton({
  title,
  question,
  message,
  confirmLabel,
  onConfirm,
  disabled = false,
  danger = false,
}: {
  title: string;
  question: string;
  message: string;
  confirmLabel: string;
  onConfirm(): void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button title={title} disabled={disabled} danger={danger} onPress={() => setOpen(true)} />
      <Sheet visible={open} title={question} onClose={() => setOpen(false)}>
        <Copy>{message}</Copy>
        <Button
          title={confirmLabel}
          primary
          danger={danger}
          disabled={disabled}
          onPress={() => {
            setOpen(false);
            onConfirm();
          }}
        />
        <Button title="取消" onPress={() => setOpen(false)} />
      </Sheet>
    </>
  );
}
export function Loading({ loading, empty }: { loading: boolean; empty?: boolean }) {
  return loading ? (
    <ActivityIndicator accessibilityLabel="正在读取" />
  ) : empty ? (
    <Copy muted>暂无内容。</Copy>
  ) : null;
}
export const styles = StyleSheet.create({
  page: {
    padding: 16,
    paddingBottom: 32,
    gap: 24,
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  input: { minHeight: 48, padding: 12, borderWidth: 1, borderRadius: 10, fontSize: 17 },
  fill: { flex: 1 },
  muted: { fontSize: 13 },
});
