import { z } from "zod";
import { buildAgentSystemPrompt } from "./system.js";
import { runtimeSources } from "./runtime.js";

/** Only explicit content mode renders the synthetic example. Never reads runtime state. */
export function inspectPrompts(options: { showContent?: boolean } = {}) {
  const built = buildAgentSystemPrompt({
    name: "示例同事",
    role: "示例角色",
    description: "合成诊断示例",
  });
  return {
    kind: "current-build",
    systemSections: built.sections.map(({ text: _text, ...source }, order) => ({
      ...source,
      order,
      ...(options.showContent ? { text: _text } : {}),
    })),
    runtimeMessages: runtimeSources,
    summaryRequest: { owner: "@earendil-works/pi-durable", mode: "blocking", backgroundTokens: 0 },
    ...(options.showContent ? { systemPrompt: built.systemPrompt } : {}),
  };
}

const systemEntrySchema = z.object({
  kind: z.literal("pi.system"),
  model: z
    .array(
      z.object({
        role: z.literal("system"),
        content: z.string(),
        sections: z.record(z.string(), z.string().nullable()).optional(),
        toolsAdded: z.array(z.json()).optional(),
        toolsRemoved: z.array(z.string()).optional(),
      }),
    )
    .length(1),
});

/** Native positional system changes are deltas, not a snapshot of the current full prompt. */
export function inspectSystemEntry(input: unknown, options: { showContent?: boolean } = {}) {
  const parsed = systemEntrySchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid Durable system entry");
  const message = parsed.data.model[0]!;
  return {
    kind: "saved-system-entry",
    provenance: "native-positional-change",
    sectionCount: Object.keys(message.sections ?? {}).length,
    toolsAddedCount: message.toolsAdded?.length ?? 0,
    toolsRemovedCount: message.toolsRemoved?.length ?? 0,
    ...(options.showContent ? { message } : {}),
  };
}
