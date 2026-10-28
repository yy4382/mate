import { t, numberText, currencyText } from "../i18n";
import type { SnapshotEvent } from "@mate/admin";
import { View } from "react-native";
import { Caption, Copy, Empty, Row, Section } from "../ui";

export function Usage({ usage }: { usage: SnapshotEvent["usage"] }) {
  const buckets = [
    { label: t("management.models"), values: usage.models },
    { label: t("management.tools"), values: usage.tools },
  ];
  if (buckets.every((bucket) => Object.keys(bucket.values).length === 0))
    return (
      <Empty
        title={t("management.no_usage_recorded_yet")}
        message={t("management.recorded_model_and_tool_usage_appears_here")}
      />
    );
  return (
    <>
      {buckets.map((bucket) =>
        Object.entries(bucket.values).map(([name, counters]) => (
          <Section key={`${bucket.label}/${name}`} title={bucket.label}>
            <View style={{ padding: 16, gap: 8 }}>
              <Copy>{name}</Copy>
              <Caption>
                {t("management.usage_summary", {
                  tokens: numberText(counters.totalTokens),
                  cost: currencyText(counters.cost.total),
                })}
              </Caption>
            </View>
            <Row title={t("management.input")} value={numberText(counters.input)} />
            <Row title={t("management.output")} value={numberText(counters.output)} />
            <Row title={t("management.cache_read")} value={numberText(counters.cacheRead)} />
            <Row title={t("management.cache_write")} value={numberText(counters.cacheWrite)} />
            {counters.reasoning !== undefined && (
              <Row
                title={t("management.reasoning_included")}
                value={numberText(counters.reasoning)}
              />
            )}
            <Row title={t("management.total_tokens")} value={numberText(counters.totalTokens)} />
            <Row title={t("management.input_cost")} value={currencyText(counters.cost.input)} />
            <Row title={t("management.output_cost")} value={currencyText(counters.cost.output)} />
            <Row
              title={t("management.cache_read_cost")}
              value={currencyText(counters.cost.cacheRead)}
            />
            <Row
              title={t("management.cache_write_cost")}
              value={currencyText(counters.cost.cacheWrite)}
            />
            <Row
              title={t("management.total_recorded_cost")}
              value={currencyText(counters.cost.total)}
            />
          </Section>
        )),
      )}
    </>
  );
}
