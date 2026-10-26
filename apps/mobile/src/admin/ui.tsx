import { createContext, useContext, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useTheme } from "../theme";
import { errorText } from "./client";

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
  const colors = useTheme();
  return (
    <Text
      selectable
      accessibilityRole={title ? "header" : undefined}
      style={{
        color: muted ? colors.muted : colors.foreground,
        fontSize: title ? 22 : 16,
        lineHeight: title ? 30 : 24,
        ...(title ? { fontWeight: "600" } : {}),
        ...(mono ? { fontFamily: "Menlo", fontSize: 13, lineHeight: 21 } : {}),
      }}
    >
      {children}
    </Text>
  );
}

export function Screen({
  children,
  onRefresh,
  refreshing = false,
  topInset = false,
}: {
  children: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  topInset?: boolean;
}) {
  return (
    <SafeAreaView
      style={{ flex: 1 }}
      edges={topInset ? ["top", "left", "right", "bottom"] : ["left", "right", "bottom"]}
    >
      <KeyboardAwareScrollView
        bottomOffset={24}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={styles.page}
      >
        {onRefresh && (
          <Button
            title={refreshing ? "正在刷新…" : "刷新"}
            disabled={refreshing}
            onPress={onRefresh}
          />
        )}
        {children}
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

export function Card({ children }: { children: ReactNode }) {
  const colors = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: colors.subtle, borderColor: colors.border }]}>
      {children}
    </View>
  );
}

export function Button({
  title,
  onPress,
  disabled = false,
  danger = false,
  primary = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
  primary?: boolean;
}) {
  const colors = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          borderColor: colors.border,
          backgroundColor: primary ? colors.foreground : colors.background,
          opacity: disabled ? 0.45 : pressed ? 0.6 : 1,
        },
      ]}
    >
      <Text
        style={{
          color: danger ? "#d33131" : primary ? colors.background : colors.foreground,
          fontSize: 17,
          fontWeight: "500",
          textAlign: "center",
        }}
      >
        {title}
      </Text>
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  ...props
}: TextInputProps & { label: string; hint?: string }) {
  const colors = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Copy>{label}</Copy>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        {...props}
        style={[
          styles.input,
          {
            color: colors.foreground,
            backgroundColor: colors.background,
            borderColor: colors.border,
          },
          props.multiline && { minHeight: 120, textAlignVertical: "top" },
          props.style,
        ]}
      />
      {hint && <Copy muted>{hint}</Copy>}
    </View>
  );
}

export const ManagementPresentationAccess = createContext(false);

function ManagementModal({
  visible,
  onClose,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ready = useContext(ManagementPresentationAccess);
  const colors = useTheme();
  return (
    <Modal
      visible={visible && ready}
      animationType="none"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
        {ready ? children : null}
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
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  return (
    <View style={{ gap: 6 }}>
      <Copy>{label}</Copy>
      <Button
        disabled={disabled}
        title={`${label}：${options.find((option) => option.value === value)?.label ?? "请选择"}`}
        onPress={() => {
          setQuery("");
          setOpen(true);
        }}
      />
      <ManagementModal visible={open} onClose={() => setOpen(false)}>
        <View style={{ padding: 16, gap: 12 }}>
          <Copy title>{label}</Copy>
          <Button title="取消选择" onPress={() => setOpen(false)} />
          {options.length > 8 && <Field label="搜索选项" value={query} onChangeText={setQuery} />}
        </View>
        <FlatList
          contentContainerStyle={{ padding: 16, gap: 10 }}
          keyboardShouldPersistTaps="handled"
          data={options.filter((option) =>
            option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
          )}
          keyExtractor={(option) => option.value}
          renderItem={({ item: option }) => (
            <Button
              title={`${option.value === value ? "✓ " : ""}${option.label}`}
              onPress={() => {
                onChange(option.value);
                setOpen(false);
              }}
            />
          )}
        />
      </ManagementModal>
    </View>
  );
}

export function ErrorLine({ error }: { error: unknown }) {
  return error == null ? null : (
    <Text
      selectable
      accessibilityRole="alert"
      style={{ color: "#d33131", fontSize: 16, lineHeight: 24 }}
    >
      {errorText(error)}
    </Text>
  );
}
export function Outcome({
  operation,
}: {
  operation: { error: unknown; message: string; busy: boolean };
}) {
  return (
    <>
      <ErrorLine error={operation.error} />
      {operation.busy ? (
        <ActivityIndicator accessibilityLabel="正在提交" />
      ) : operation.message ? (
        <Copy>{operation.message}</Copy>
      ) : null}
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
  onConfirm: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button title={title} disabled={disabled} danger={danger} onPress={() => setOpen(true)} />
      <ManagementModal visible={open} onClose={() => setOpen(false)}>
        <Screen topInset>
          <Copy title>{question}</Copy>
          <Copy>{message}</Copy>
          <Button title="取消" onPress={() => setOpen(false)} />
          <Button
            title={confirmLabel}
            danger={danger}
            disabled={disabled}
            onPress={() => {
              setOpen(false);
              onConfirm();
            }}
          />
        </Screen>
      </ManagementModal>
    </>
  );
}
export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={{ gap: 2 }}>
      <Copy muted>{label}</Copy>
      <Copy>{value}</Copy>
    </View>
  );
}
export const dateText = (value: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN") : "尚未连接";
export const bytesText = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1024 * 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1024 / 1024).toFixed(1)} MB`;
const styles = StyleSheet.create({
  page: {
    padding: 16,
    gap: 16,
    paddingBottom: 40,
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  card: { borderWidth: 1, borderRadius: 12, padding: 16, gap: 14 },
  input: { minHeight: 48, borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 17 },
  button: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    justifyContent: "center",
  },
});
