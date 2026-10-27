import type { SnapshotEvent } from "@mate/admin";
import { View } from "react-native";
import { Caption, Copy, Empty, Row, Section } from "../ui";

export function Usage({ usage }: { usage: SnapshotEvent["usage"] }) {
  const buckets = [
    { label: "模型", values: usage.models },
    { label: "工具", values: usage.tools },
  ];
  if (buckets.every((bucket) => Object.keys(bucket.values).length === 0))
    return <Empty title="尚无用量记录" message="这里显示模型与工具已记录的用量。" />;
  return (
    <>
      {buckets.map((bucket) =>
        Object.entries(bucket.values).map(([name, counters]) => (
          <Section key={`${bucket.label}/${name}`} title={bucket.label}>
            <View style={{ padding: 16, gap: 8 }}>
              <Copy>{name}</Copy>
              <Caption>
                {counters.totalTokens.toLocaleString()} tokens · 记录费用 $
                {counters.cost.total.toFixed(6)}
              </Caption>
            </View>
            <Row title="输入" value={counters.input.toLocaleString()} />
            <Row title="输出" value={counters.output.toLocaleString()} />
            <Row title="缓存读取" value={counters.cacheRead.toLocaleString()} />
            <Row title="缓存写入" value={counters.cacheWrite.toLocaleString()} />
            {counters.reasoning !== undefined && (
              <Row title="其中思考" value={counters.reasoning.toLocaleString()} />
            )}
            <Row title="总 tokens" value={counters.totalTokens.toLocaleString()} />
            <Row title="输入费用" value={`$${counters.cost.input.toFixed(6)}`} />
            <Row title="输出费用" value={`$${counters.cost.output.toFixed(6)}`} />
            <Row title="缓存读取费用" value={`$${counters.cost.cacheRead.toFixed(6)}`} />
            <Row title="缓存写入费用" value={`$${counters.cost.cacheWrite.toFixed(6)}`} />
            <Row title="记录总费用" value={`$${counters.cost.total.toFixed(6)}`} />
          </Section>
        )),
      )}
    </>
  );
}
