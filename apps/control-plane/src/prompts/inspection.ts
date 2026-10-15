import { z } from "zod";
import { buildAgentSystemPrompt } from "./system.js";
import { runtimeVersions } from "../runtime/build-identity.js";
import { existsSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { runtimeSources } from "./runtime.js";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";

/** Only explicit content mode renders the synthetic example. Never reads runtime state. */
export function inspectPrompts(options: { showContent?: boolean } = {}) {
  const built = buildAgentSystemPrompt({
    name: "示例同事",
    role: "示例角色",
    description: "合成诊断示例",
  });
  return {
    kind: "current-build",
    runtimeVersions,
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
        toolsAdded: z
          .array(
            z.object({
              name: z.string(),
              description: z.string().optional(),
              parameters: z.json().optional(),
            }),
          )
          .optional(),
        toolsRemoved: z.array(z.object({ name: z.string() })).optional(),
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

const configurationSchema = z.object({
  model: z.object({ provider: z.string(), modelId: z.string() }).optional(),
  thinkingLevel: z.string().optional(),
});
const versionsSchema = z.object({
  runtimeVersions: z.object({
    controlPlane: z.string(),
    piDurable: z.string(),
    piAi: z.string(),
    chord: z.string(),
  }),
});

/** Observe adopted native facts without opening a Harness or emitting conversation content. */
export async function inspectSession(
  path: string,
  options: { showContent?: boolean; conversationId?: number } = {},
) {
  if (!existsSync(path)) throw new Error("Session unavailable");
  const database = await openNodeSqliteDatabase(path);
  let storage;
  try {
    await database.exec("PRAGMA synchronous=FULL;");
    storage = await SqliteStorage.open(database);
    const selected = options.conversationId ?? ROOT_CONVERSATION_ID;
    let conversation;
    let cursor;
    do {
      const page = await storage.scanConversations({}, 100, cursor, BACKGROUND_CONTEXT);
      conversation = page.items.find((item) => item.id === selected);
      cursor = page.next;
    } while (!conversation && cursor);
    if (!conversation) throw new Error("Session unavailable");
    const conversationId = conversation.id;
    for (;;) {
      const scope = { kind: "conversation" as const, conversationId };
      const agent = await storage.findDocument(
        { kind: "pi.agent", scope },
        "current",
        BACKGROUND_CONTEXT,
      );
      const configured = agent && (await storage.document(agent.id, "current", BACKGROUND_CONTEXT));
      const admission = await storage.findDocument(
        { kind: "mate.admission", scope: { kind: "session" } },
        "current",
        BACKGROUND_CONTEXT,
      );
      const adopted =
        admission && (await storage.document(admission.id, "current", BACKGROUND_CONTEXT));
      const tail = (await storage.scanEntries({ conversationId }, 1, undefined, BACKGROUND_CONTEXT))
        .items[0]?.id;
      // A newly committed summary need not have a new system baseline yet. Inspect the
      // last committed system change against its own head, rather than discard the
      // configuration that the provider actually received before that summary.
      const entries = [];
      let entryCursor;
      if (tail !== undefined)
        do {
          const page = await storage.scanEntries(
            { conversationId, order: "ascending", maxEntryId: tail },
            100,
            entryCursor,
            BACKGROUND_CONTEXT,
          );
          entries.push(...page.items);
          entryCursor = page.next;
        } while (entryCursor);
      const lastSystem = entries.findLast((entry) => entry.kind === "pi.system");
      const head =
        lastSystem &&
        (await storage.findLatestHeadMarker(conversationId, lastSystem.id, BACKGROUND_CONTEXT));
      const messages = [];
      let lastModel;
      let requestThinkingLevel: string | null = null;
      for (const entry of entries) {
        const message = entry.model?.[0];
        if (entry.kind === "pi.assistant" && message?.role === "assistant") {
          lastModel = { provider: message.provider, modelId: message.model };
          const request = z
            .object({ mateRequest: z.object({ thinkingLevel: z.string() }).nullable() })
            .safeParse(entry.data);
          requestThinkingLevel = request.success
            ? (request.data.mateRequest?.thinkingLevel ?? null)
            : null;
        }
        if (entry.kind === "pi.system" && (!head || entry.id > head.id)) {
          const parsed = systemEntrySchema.parse(entry);
          messages.push(parsed.model[0]!);
        }
      }
      const currentConfigured =
        agent && (await storage.document(agent.id, "current", BACKGROUND_CONTEXT));
      const currentAdopted =
        admission && (await storage.document(admission.id, "current", BACKGROUND_CONTEXT));
      if (
        JSON.stringify(configured?.value) !== JSON.stringify(currentConfigured?.value) ||
        JSON.stringify(adopted?.value) !== JSON.stringify(currentAdopted?.value)
      )
        continue;
      const tools = getCurrentTools(messages);
      const systemPrompt = getCurrentSystemPrompt(messages);
      return {
        kind: "saved-session-configuration",
        conversationId,
        provenance: "committed-system-changes",
        runtimeVersions: adopted ? versionsSchema.parse(adopted.value).runtimeVersions : null,
        inspectorVersions: runtimeVersions,
        model: lastModel ?? null,
        configuredModel: configured
          ? (configurationSchema.parse(configured.value).model ?? null)
          : null,
        configuredThinkingLevel: configured
          ? (configurationSchema.parse(configured.value).thinkingLevel ?? "default")
          : null,
        requestThinkingLevel,
        systemEntryCount: messages.length,
        systemPromptChars: systemPrompt.length,
        toolCount: tools.length,
        ...(options.showContent ? { systemPrompt, tools } : {}),
      };
    }
  } finally {
    if (storage) await storage.close(BACKGROUND_CONTEXT);
    else await database.close();
  }
}
