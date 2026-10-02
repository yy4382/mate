import { sessionConfigurationSchema } from "../runtime/session/record.js";
import { buildAgentSystemPrompt } from "./system.js";
import { runtimeSources } from "./runtime.js";
import { summarySources } from "./summary.js";

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
    summaryRequest: summarySources,
    ...(options.showContent ? { systemPrompt: built.systemPrompt } : {}),
  };
}

/** Read only the established configuration shape; never serialize arbitrary input fields. */
export function inspectConfigurationSnapshot(
  input: unknown,
  options: { showContent?: boolean } = {},
) {
  const record =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const candidate = record.kind === "configuration" ? record.configuration : record;
  const raw =
    typeof candidate === "object" && candidate !== null
      ? (candidate as Record<string, unknown>)
      : {};
  const parsed = sessionConfigurationSchema.safeParse(
    Object.fromEntries(Object.keys(sessionConfigurationSchema.shape).map((key) => [key, raw[key]])),
  );
  if (!parsed.success) throw new Error("Invalid configuration snapshot");
  return {
    kind: "saved-configuration",
    // formatVersion 1 stores final text and schemas, not section provenance. Do not infer it
    // from today's templates or split profile fields on newlines.
    provenance: "unavailable-in-snapshot",
    source: "apps/control-plane/src/runtime/session/record.ts#sessionConfigurationSchema",
    toolCount: parsed.data.tools.length,
    ...(options.showContent
      ? { systemPrompt: parsed.data.systemPrompt, tools: parsed.data.tools }
      : {}),
  };
}
