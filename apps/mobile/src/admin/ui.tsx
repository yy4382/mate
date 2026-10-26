import { ActivityIndicator, View } from "react-native";
import type { ReactNode } from "react";
import { Copy, ErrorLine as SharedErrorLine } from "../ui";
import { errorText } from "./client";
export {
  Copy,
  Screen,
  Card,
  Button,
  Field,
  Select,
  ConfirmButton,
  Loading,
  PresentationAccess as ManagementPresentationAccess,
} from "../ui";
export function ErrorLine({ error }: { error: unknown }) {
  return error == null ? null : <SharedErrorLine text={errorText(error)} />;
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
