import type { SnapshotEvent } from "@mate/admin";
import { Card, Copy, Fact } from "./ui";

export function Usage({ usage }: { usage: SnapshotEvent["usage"] }) {
  const buckets = [
    { label: "模型", values: usage.models },
    { label: "工具", values: usage.tools },
  ];
  return (
    <Card>
      <Copy title>用量</Copy>
      {buckets.every((bucket) => Object.keys(bucket.values).length === 0) && (
        <Copy muted>尚无用量记录。</Copy>
      )}
      {buckets.map((bucket) =>
        Object.entries(bucket.values).map(([name, counters]) => (
          <Card key={`${bucket.label}/${name}`}>
            <Copy>
              {bucket.label} · {name}
            </Copy>
            <Fact label="总 tokens" value={counters.totalTokens.toLocaleString()} />
            <Copy muted>
              输入 {counters.input.toLocaleString()} · 输出 {counters.output.toLocaleString()}
            </Copy>
            <Copy muted>
              缓存读取 {counters.cacheRead.toLocaleString()} · 缓存写入{" "}
              {counters.cacheWrite.toLocaleString()}
            </Copy>
            {counters.reasoning !== undefined && (
              <Copy muted>其中思考 {counters.reasoning.toLocaleString()}</Copy>
            )}
            <Copy muted>记录费用 ${counters.cost.total.toFixed(6)}</Copy>
          </Card>
        )),
      )}
    </Card>
  );
}
