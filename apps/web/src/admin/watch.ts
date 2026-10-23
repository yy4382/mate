import type { AgentEvent } from "@mate/admin";

type Entry = Extract<AgentEvent, { type: "snapshot" }>["entries"][number];

export type ToolRun = { name: string; args: string; output: string; done: boolean };

/** What an admin sees of an Agent's conversation, built from the event batches the control plane streams. */
export type Watching = {
  entries: Entry[];
  /** The assistant message being written, by content index. */
  streaming: Record<number, string>;
  tools: Record<string, ToolRun>;
  notes: string[];
  ended: boolean;
};

export const initial: Watching = { entries: [], streaming: {}, tools: {}, notes: [], ended: false };

const withEntry = (entries: Entry[], entry: Entry | undefined): Entry[] =>
  entry === undefined || entries.some((e) => e.id === entry.id) ? entries : [...entries, entry];

function apply(state: Watching, event: AgentEvent): Watching {
  switch (event.type) {
    case "snapshot":
      return { ...state, entries: [...event.entries], streaming: {}, tools: {} };
    case "message_update": {
      const streaming = { ...state.streaming };
      for (const change of event.changes) {
        if (change.type === "text_start" || change.type === "thinking_start")
          streaming[change.contentIndex] = "";
        else if (change.type === "text_delta" || change.type === "thinking_delta")
          streaming[change.contentIndex] = (streaming[change.contentIndex] ?? "") + change.delta;
      }
      return { ...state, streaming };
    }
    case "message_end":
      return { ...state, entries: withEntry(state.entries, event.entry), streaming: {} };
    case "entry_appended":
      return { ...state, entries: withEntry(state.entries, event.entry) };
    case "tool_execution_start":
      return {
        ...state,
        tools: {
          ...state.tools,
          [event.toolCallId]: {
            name: event.toolName,
            args: JSON.stringify(event.args),
            output: "",
            done: false,
          },
        },
      };
    case "tool_execution_update": {
      const run = state.tools[event.toolCallId];
      if (run === undefined || event.output === undefined) return state;
      const output =
        "set" in event.output
          ? event.output.set
          : run.output.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
      return { ...state, tools: { ...state.tools, [event.toolCallId]: { ...run, output } } };
    }
    case "tool_execution_end": {
      const run = state.tools[event.toolCallId];
      return {
        ...state,
        entries: withEntry(state.entries, event.entry),
        tools:
          run === undefined
            ? state.tools
            : { ...state.tools, [event.toolCallId]: { ...run, done: true } },
      };
    }
    case "task_failed":
      return { ...state, notes: [...state.notes, `${event.kind} 失败：${event.message}`] };
    case "auto_retry_start":
      return {
        ...state,
        notes: [...state.notes, `模型请求失败，第 ${event.attempt} 次重试：${event.errorMessage}`],
      };
    default:
      return state;
  }
}

export function reduce(state: Watching, action: AgentEvent[] | "ended"): Watching {
  if (action === "ended") return { ...state, ended: true };
  return action.reduce(apply, state);
}

type Block = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown };

/** One readable line per message of an entry; entries that carry no model messages show their kind. */
export function describeEntry(entry: Entry): { role: string; text: string }[] {
  const messages = (entry.model ?? []) as unknown as { role: string; content: string | Block[] }[];
  if (messages.length === 0)
    return [{ role: entry.kind, text: entry.data === undefined ? "" : JSON.stringify(entry.data) }];
  return messages.map((message) => ({
    role: message.role,
    text:
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((block) =>
              block.type === "text"
                ? (block.text ?? "")
                : block.type === "thinking"
                  ? `（思考）${block.thinking ?? ""}`
                  : block.type === "toolCall"
                    ? `调用 ${block.name ?? "?"} ${JSON.stringify(block.arguments)}`
                    : `[${block.type}]`,
            )
            .join("\n"),
  }));
}
