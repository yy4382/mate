import { EyeOff } from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import type { AgentEvent } from "@mate/admin";
import { get, redirectToLogin } from "../shell/api.ts";
import { Badge, EmptyState, ErrorLine, Field, Notice, Select, cx } from "../shell/ui.tsx";
import { describeEntry, initial, reduce } from "./watch.ts";

const ROLE: Record<string, string> = {
  user: "输入",
  assistant: "Agent",
  toolResult: "工具结果",
};

function Line(props: { role: string; streaming?: boolean; text: string }) {
  return (
    <li
      className={cx(
        "grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 px-4 py-3",
        props.role === "user" && "bg-subtle",
      )}
    >
      <span className="flex items-center gap-1.5 self-start pt-px text-xs text-muted">
        {ROLE[props.role] ?? props.role}
        {props.streaming === true ? (
          <span
            role="img"
            aria-label="正在写"
            className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse"
          />
        ) : null}
      </span>
      <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-xs leading-5">
        {props.text}
      </pre>
    </li>
  );
}

/** An Agent's conversation as it happens: what it was told, what it said, and the tools it ran. */
export function Watch({ agentId, open }: { agentId: string; open: boolean }) {
  const [assistants, setAssistants] = useState<string[]>([]);
  const [assistant, setAssistant] = useState("");
  const [state, dispatch] = useReducer(reduce, initial);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    get<string[]>(`/api/admin/agents/${agentId}/assistants`).then(setAssistants, () => undefined);
  }, [agentId, open]);

  useEffect(() => {
    if (!open) return;
    setProblem(null);
    const source = new EventSource(
      `/api/admin/agents/${agentId}/events${assistant === "" ? "" : `?assistant=${encodeURIComponent(assistant)}`}`,
    );
    let received = false;
    source.addEventListener("events", (message) => {
      received = true;
      dispatch(JSON.parse((message as MessageEvent<string>).data) as AgentEvent[]);
    });
    source.addEventListener("ended", () => {
      source.close();
      dispatch("ended");
    });
    source.addEventListener("login", () => redirectToLogin());
    source.addEventListener("error", () => {
      if (source.readyState === EventSource.CLOSED && !received) setProblem("无法观察这个 Agent。");
    });
    return () => source.close();
  }, [agentId, assistant, open]);

  if (!open)
    return (
      <EmptyState icon={<EyeOff />} title="Agent 没有在运行">
        没有可观察的对话。恢复它之后再来看。
      </EmptyState>
    );
  const tools = Object.entries(state.tools);
  const lines = state.entries.flatMap((entry) =>
    describeEntry(entry).map((line, index) => ({ key: `${entry.id}-${index}`, ...line })),
  );
  const streaming = Object.entries(state.streaming);
  return (
    <div className="grid gap-6">
      {assistants.length > 0 ? (
        <Field label="观察" className="max-w-xs">
          <Select value={assistant} onChange={(event) => setAssistant(event.target.value)}>
            <option value="">Agent 本身</option>
            {assistants.map((name) => (
              <option key={name} value={name}>
                工作助手 {name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <ErrorLine error={problem} />
      {state.ended ? <Notice>观察已结束（Agent 已暂停或删除）。</Notice> : null}
      <ol
        className="divide-y divide-border overflow-hidden rounded-lg border border-border"
        data-testid="transcript"
      >
        {lines.length === 0 && streaming.length === 0 ? (
          <li className="px-4 py-6 text-center text-sm text-muted">还没有对话内容。</li>
        ) : null}
        {lines.map((line) => (
          <Line key={line.key} role={line.role} text={line.text} />
        ))}
        {streaming.map(([index, text]) => (
          <Line key={`s${index}`} role="assistant" streaming text={text} />
        ))}
      </ol>
      {tools.length > 0 ? (
        <section className="grid gap-3">
          <h2 className="text-base font-semibold">工具调用</h2>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {tools.map(([id, run]) => (
              <li key={id} className="grid gap-2 px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="shrink-0 text-sm font-medium">{run.name}</span>
                  <code
                    title={run.args}
                    className="min-w-0 flex-1 truncate font-mono text-xs text-muted"
                  >
                    {run.args}
                  </code>
                  <Badge tone={run.done ? "neutral" : "accent"}>
                    {run.done ? "完成" : "运行中"}
                  </Badge>
                </div>
                {run.output === "" ? null : (
                  <details>
                    <summary className="cursor-pointer text-xs text-muted">输出</summary>
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-subtle p-3 font-mono text-xs leading-5">
                      {run.output}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {state.notes.map((note, index) => (
        <Notice key={index}>{note}</Notice>
      ))}
    </div>
  );
}
