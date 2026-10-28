import { t, dateText as formatDate, numberText } from "../i18n";
import { ActivityIndicator } from "react-native";
import { Copy, ErrorLine as SharedErrorLine } from "../ui";
import { errorText } from "./client";
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
        <ActivityIndicator accessibilityLabel={t("management.submitting")} />
      ) : operation.message ? (
        <Copy>{operation.message}</Copy>
      ) : null}
    </>
  );
}
export const dateText = (value: string | null) =>
  value ? formatDate(value) : t("management.never_connected");
export const bytesText = (value: number) =>
  value < 1024
    ? t("management.bytes", { size: numberText(value) })
    : value < 1024 * 1024
      ? t("management.kilobytes", {
          size: numberText(value / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
        })
      : t("management.megabytes", {
          size: numberText(value / 1024 / 1024, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          }),
        });
