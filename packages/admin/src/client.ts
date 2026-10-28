/**
 * Pure helpers both clients run on what the control plane serves: the observation reducer over an Agent's event stream,
 * and the node pairing command. Node-free, so the web and native apps import it at runtime.
 */
import type { AgentEvent, SnapshotEvent } from "@mate/runtime";

export type Entry = SnapshotEvent["entries"][number];
type Block = Extract<NonNullable<Entry["model"]>[number], { role: "assistant" }>["content"][number];
export type ObservedTool = {
  name: string;
  args: unknown;
  output: string;
  status: "pending" | "running" | "done";
};
/** Something worth telling the reader that is not an entry; each client words it. */
export type ObservationNote =
  | { kind: "request-retry"; error: string }
  | { kind: "compacting" }
  | { kind: "compaction-ended" }
  | { kind: "model-retry"; attempt: number; error: string }
  | { kind: "task-failed"; task: string; error: string };
export type Observation = {
  entries: readonly Entry[];
  streaming: Record<number, Block>;
  tools: Record<string, ObservedTool>;
  run: boolean;
  queued: number;
  usage: SnapshotEvent["usage"];
  agent: SnapshotEvent["agent"];
  notes: ObservationNote[];
  ended: boolean;
};
export const initialObservation: Observation = {
  entries: [],
  streaming: {},
  tools: {},
  run: false,
  queued: 0,
  usage: { models: {}, tools: {} },
  agent: {},
  notes: [],
  ended: false,
};
const append = (entries: readonly Entry[], entry: Entry | undefined) =>
  entry && !entries.some((previous) => previous.id === entry.id) ? [...entries, entry] : entries;
export type ToolCall = Extract<Block, { type: "toolCall" }>;
/** The recorded tool calls by call ID, keeping the first record of each. */
export function toolCalls(entries: readonly Entry[]): Map<string, ToolCall> {
  const calls = new Map<string, ToolCall>();
  for (const entry of entries)
    for (const message of entry.model ?? [])
      if (message.role === "assistant")
        for (const block of message.content)
          if (block.type === "toolCall" && !calls.has(block.id)) calls.set(block.id, block);
  return calls;
}
function apply(state: Observation, event: AgentEvent): Observation {
  switch (event.type) {
    case "snapshot": {
      const calls = toolCalls(event.entries);
      return {
        ...initialObservation,
        entries: event.entries,
        run: event.run !== undefined,
        queued: event.inbox.length,
        agent: event.agent,
        usage: event.usage,
        streaming: Object.fromEntries(
          (event.generation?.message?.content ?? []).map((block, index) => [index, block]),
        ),
        tools: Object.fromEntries(
          event.tools.map((tool) => [
            tool.callId,
            {
              name: tool.name,
              args: calls.get(tool.callId)?.arguments,
              output: tool.output ?? "",
              status: tool.status,
            },
          ]),
        ),
        notes: [
          ...(event.generation?.retry
            ? [{ kind: "request-retry", error: event.generation.retry.error } as const]
            : []),
          ...event.compactions.map(() => ({ kind: "compacting" }) as const),
        ],
      };
    }
    case "run_start":
      return { ...state, run: true };
    case "run_end":
      return { ...state, run: false, streaming: {} };
    case "inbox_update":
      return { ...state, queued: event.items.length };
    case "agent_changed":
      return { ...state, agent: event.agent };
    case "usage_changed":
      return { ...state, usage: event.usage };
    case "message_start":
      return { ...state, streaming: {} };
    case "message_update": {
      let streaming = { ...state.streaming };
      for (const change of event.changes) {
        if (change.type === "message")
          streaming = Object.fromEntries(
            change.message.content.map((block, index) => [index, block]),
          );
        else if (
          change.type === "block" ||
          change.type === "text_start" ||
          change.type === "thinking_start" ||
          change.type === "toolcall_start"
        )
          streaming[change.contentIndex] = change.block;
        else if (change.type === "text_delta") {
          const old = streaming[change.contentIndex];
          streaming[change.contentIndex] = {
            type: "text",
            text: (old?.type === "text" ? old.text : "") + change.delta,
          };
        } else if (change.type === "thinking_delta") {
          const old = streaming[change.contentIndex];
          streaming[change.contentIndex] = {
            type: "thinking",
            thinking: (old?.type === "thinking" ? old.thinking : "") + change.delta,
          };
        }
      }
      return { ...state, streaming };
    }
    case "message_end":
      return { ...state, entries: append(state.entries, event.entry), streaming: {} };
    case "entry_appended":
      return { ...state, entries: append(state.entries, event.entry) };
    case "tool_execution_start":
      return {
        ...state,
        tools: {
          ...state.tools,
          [event.toolCallId]: {
            name: event.toolName,
            args: event.args,
            output: "",
            status: "running",
          },
        },
      };
    case "tool_execution_update": {
      const tool = state.tools[event.toolCallId];
      if (!tool || !event.output) return state;
      const output =
        "set" in event.output
          ? event.output.set
          : tool.output.slice(event.output.trimStart ?? 0) + (event.output.append ?? "");
      return { ...state, tools: { ...state.tools, [event.toolCallId]: { ...tool, output } } };
    }
    case "tool_execution_end": {
      const tool = state.tools[event.toolCallId];
      return {
        ...state,
        entries: append(state.entries, event.entry),
        tools: {
          ...state.tools,
          [event.toolCallId]: {
            name: event.toolName,
            args: tool?.args,
            output: tool?.output ?? "",
            status: "done",
          },
        },
      };
    }
    case "auto_retry_start":
      return {
        ...state,
        notes: [
          ...state.notes,
          { kind: "model-retry", attempt: event.attempt, error: event.errorMessage },
        ],
      };
    case "task_failed":
      return {
        ...state,
        notes: [...state.notes, { kind: "task-failed", task: event.kind, error: event.message }],
      };
    case "compaction_start":
      return { ...state, notes: [...state.notes, { kind: "compacting" }] };
    case "compaction_end":
      return { ...state, notes: [...state.notes, { kind: "compaction-ended" }] };
    default:
      return state;
  }
}
export function observeEvents(state: Observation, events: AgentEvent[] | "ended"): Observation {
  return events === "ended" ? { ...state, ended: true, run: false } : events.reduce(apply, state);
}

/** The command an operator runs on a node's machine to pair it with this control plane. */
export const pairingCommand = (controlPlane: string, pairingToken: string) =>
  `mate node configure --control-plane ${controlPlane} --pairing-token ${pairingToken}`;
