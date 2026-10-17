import { useEffect, useReducer, useState } from "react";
import type { AgentEvent } from "@mate/admin";
import { get, redirectToLogin } from "../shell/api.ts";
import { describeEntry, initial, reduce } from "./watch.ts";

const ROLE: Record<string, string> = {
  user: "输入",
  assistant: "Agent",
  toolResult: "工具结果",
};

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
    return <p className="notice">Agent 没有在运行，没有可观察的对话。恢复它之后再来看。</p>;
  const tools = Object.entries(state.tools);
  return (
    <section className="watch">
      {assistants.length > 0 ? (
        <label>
          观察
          <select value={assistant} onChange={(event) => setAssistant(event.target.value)}>
            <option value="">Agent 本身</option>
            {assistants.map((name) => (
              <option key={name} value={name}>
                工作助手 {name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {problem === null ? null : <p className="error">{problem}</p>}
      {state.ended ? (
        <p className="notice" role="status">
          观察已结束（Agent 已暂停或删除）。
        </p>
      ) : null}
      <ol className="transcript" data-testid="transcript">
        {state.entries.flatMap((entry) =>
          describeEntry(entry).map((line, index) => (
            <li key={`${entry.id}-${index}`} className={`line ${line.role}`}>
              <span className="role">{ROLE[line.role] ?? line.role}</span>
              <pre>{line.text}</pre>
            </li>
          )),
        )}
        {Object.entries(state.streaming).map(([index, text]) => (
          <li key={`s${index}`} className="line assistant streaming">
            <span className="role">Agent（正在写）</span>
            <pre>{text}</pre>
          </li>
        ))}
      </ol>
      {tools.length > 0 ? (
        <>
          <h3>工具调用</h3>
          <ul className="tools">
            {tools.map(([id, run]) => (
              <li key={id}>
                <strong>{run.name}</strong> <code>{run.args}</code>
                <span className="tag">{run.done ? "完成" : "运行中"}</span>
                {run.output === "" ? null : <pre>{run.output}</pre>}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {state.notes.map((note, index) => (
        <p key={index} className="notice">
          {note}
        </p>
      ))}
    </section>
  );
}
