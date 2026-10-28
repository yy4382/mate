import { t } from "../i18n.ts";
import type { Entry, ObservationNote } from "@mate/admin/client";

type Block = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown };

/** One content block as a line of text. */
export const blockText = (block: Block): string =>
  block.type === "text"
    ? (block.text ?? "")
    : block.type === "thinking"
      ? t("watch.thinking", { text: block.thinking ?? "" })
      : block.type === "toolCall"
        ? t("watch.toolCall", {
            name: block.name ?? "?",
            arguments: JSON.stringify(block.arguments),
          })
        : `[${block.type}]`;

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
        : message.content.map(blockText).join("\n"),
  }));
}

export function watchLabel(kind: string): string {
  const labels: Record<string, string> = {
    system: t("watchLabels.system"),
    reset: t("watchLabels.reset"),
    compaction: t("watchLabels.compaction"),
    user: t("watchLabels.user"),
    assistant: t("watchLabels.assistant"),
    toolResult: t("watchLabels.toolResult"),
    "pi.user": t("watchLabels.pi_user"),
    "pi.assistant": t("watchLabels.pi_assistant"),
    "pi.system": t("watchLabels.pi_system"),
    "pi.tool-result": t("watchLabels.pi_tool_result"),
    "pi.reset": t("watchLabels.pi_reset"),
    "pi.compaction": t("watchLabels.pi_compaction"),
    "pi.generation": t("watchLabels.pi_generation"),
    "pi.tool": t("watchLabels.pi_tool"),

    "mate.input-delivery": t("watchLabels.mate_input_delivery"),
    "mate.assistant-anchor": t("watchLabels.mate_assistant_anchor"),
    "mate.background-command": t("watchLabels.mate_background_command"),
  };
  return labels[kind] ?? kind;
}

export function noteText(note: ObservationNote): string {
  switch (note.kind) {
    case "request-retry":
      return t("watch.requestRetry", { message: note.error });
    case "compacting":
      return t("watch.compacting");
    case "compaction-ended":
      return t("watch.compactionEnded");
    case "model-retry":
      return t("watch.retry", { count: note.attempt, message: note.error });
    case "task-failed":
      return t("watch.taskFailed", { kind: watchLabel(note.task), message: note.error });
  }
}
