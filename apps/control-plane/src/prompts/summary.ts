import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, normalizeContext } from "@earendil-works/pi-ai";
import type { PromptSource } from "./types.js";

const TOOL_RESULT_MAX_CHARS = 2_000;
const SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
const INITIAL_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:
## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]
## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact conversation IDs, task ownership, pending work, tool names, arguments, results, paths and error messages. A tool result is an observation, not permission to repeat a side effect.`;
const UPDATE_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary. Preserve previous facts, add new progress and decisions, move completed work to Done, and update Next Steps. Preserve exact conversation IDs, task ownership, pending work, tool names, arguments, results, paths and error messages. Remove a prior fact only if it is no longer relevant. Use the same format as the previous summary.`;
const PREFIX_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.
Summarize the prefix to provide context for the retained suffix:
## Original Request
[What was requested in this turn?]

## Early Progress
- [Key decisions, tool observations and work done in the prefix]
## Context for Suffix
- [Information needed to understand the retained recent work, including uncertain effects]

Be concise. Focus on what's needed to understand the kept suffix.`;

export const summarySources: PromptSource[] = [
  {
    id: "summary-system",
    source: "apps/control-plane/src/prompts/summary.ts#SYSTEM_PROMPT",
    condition: "每次摘要请求；独立请求，不提供工作工具",
    role: "system",
  },
  {
    id: "summary-history",
    source: "apps/control-plane/src/prompts/summary.ts#serialize",
    condition: "被选中总结的历史；只在临时文本中截断工具结果，不改原始记录",
    role: "user",
  },
  {
    id: "summary-previous",
    source: "apps/control-plane/src/prompts/summary.ts#buildSummaryRequest",
    condition: "previous 为非空摘要时，放在 conversation 之后",
    role: "user",
  },
  {
    id: "summary-initial",
    source: "apps/control-plane/src/prompts/summary.ts#INITIAL_PROMPT",
    condition: "非长轮次前缀且没有非空前次摘要；放在历史材料之后",
    role: "user",
  },
  {
    id: "summary-update",
    source: "apps/control-plane/src/prompts/summary.ts#UPDATE_PROMPT",
    condition: "非长轮次前缀且有非空前次摘要；放在历史材料之后",
    role: "user",
  },
  {
    id: "summary-prefix",
    source: "apps/control-plane/src/prompts/summary.ts#PREFIX_PROMPT",
    condition: "总结长轮次前缀；优先于 initial/update，放在历史材料之后",
    role: "user",
  },
];

/** Text-only, tool-free summary request. The caller still owns capacity and commit policy. */
export function buildSummaryRequest(
  messages: AgentMessage[],
  previous: string | undefined,
  prefix: boolean,
) {
  const conversation = serialize(messages);
  const prompt = `<conversation>\n${conversation}\n</conversation>\n\n${previous ? `<previous-summary>\n${previous}\n</previous-summary>\n\n` : ""}${prefix ? PREFIX_PROMPT : previous ? UPDATE_PROMPT : INITIAL_PROMPT}`;
  return {
    systemPrompt: SYSTEM_PROMPT,
    prompt,
    context: normalizeContext({
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
      ],
    }),
  };
}

function serialize(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const content = contentText(message.content, "");
      if (content) parts.push(`[User]: ${content}`);
    } else if (message.role === "assistant") {
      const thinking = message.content
        .filter((block) => block.type === "thinking")
        .map((block) => block.thinking);
      const calls = message.content
        .filter((block) => block.type === "toolCall")
        .map(
          (block) =>
            `${block.name}(${Object.entries(block.arguments)
              .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
              .join(", ")})`,
        );
      if (thinking.length) parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
      if (message.content.some((block) => block.type === "text"))
        parts.push(`[Assistant]: ${contentText(message.content)}`);
      if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    } else if (message.role === "toolResult") {
      const content = contentText(message.content, "");
      if (content)
        parts.push(
          `[Tool result]: ${content.length <= TOOL_RESULT_MAX_CHARS ? content : `${content.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${content.length - TOOL_RESULT_MAX_CHARS} more characters truncated]`}`,
        );
    }
  }
  return parts.join("\n\n");
}
