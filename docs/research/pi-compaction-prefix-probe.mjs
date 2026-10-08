// Credential-free request-serialization probe. No model or HTTP request is made.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const root = process.argv[2] ?? process.cwd();
const importPiModule = (path) =>
  import(pathToFileURL(`${root}/node_modules/@earendil-works/pi-ai/dist/${path}`).href);
const { builtinModels } = await importPiModule("providers/all.js");
const { normalizeContext, Type } = await importPiModule("index.js");
const models = builtinModels();
const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const declarations = [
  {
    name: "read_note",
    description: "Read a synthetic note.",
    parameters: Type.Object({ path: Type.String() }),
  },
];
let fetchCalls = 0;
async function captureRequestPayload(model, context, extra = {}) {
  const { stream } = await importPiModule(`api/${model.api}.js`);
  let payload;
  const response = await stream(model, normalizeContext(context), {
    apiKey: "synthetic-never-sent",
    env: {},
    sessionId: "stable-agent-session",
    cacheRetention: "short",
    maxTokens: 4096,
    maxRetries: 0,
    ...(model.provider === "anthropic"
      ? { thinkingEnabled: true, effort: "medium" }
      : { reasoningEffort: "medium", reasoningSummary: "auto" }),
    fetch: async () => {
      fetchCalls++;
      throw new Error("NETWORK_FORBIDDEN");
    },
    onPayload: (value) => {
      payload = structuredClone(value);
      throw new Error("CAPTURE_COMPLETE");
    },
    ...extra,
  }).result();
  assert.ok(payload, response.errorMessage);
  assert.equal(response.stopReason, "error");
  assert.match(response.errorMessage, /CAPTURE_COMPLETE/);
  return payload;
}
function withoutCacheMarkers(value) {
  if (Array.isArray(value)) return value.map(withoutCacheMarkers);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "cache_control")
        .map(([key, item]) => [key, withoutCacheMarkers(item)]),
    );
  return value;
}
const comparisons = [];
for (const [provider, id] of [
  ["openai", "gpt-5.4"],
  ["anthropic", "claude-sonnet-4-6"],
]) {
  const model = models.getModel(provider, id);
  assert.ok(model);
  const assistant = (content, stopReason = "stop") => ({
    role: "assistant",
    content,
    api: model.api,
    provider,
    model: id,
    usage: zeroUsage,
    stopReason,
    timestamp: 2,
  });
  const signedThinking =
    provider === "anthropic"
      ? {
          type: "thinking",
          thinking: "Synthetic reasoning",
          thinkingSignature: "synthetic-signature",
        }
      : {
          type: "thinking",
          thinking: "Synthetic reasoning",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: "rs_synthetic",
            encrypted_content: "synthetic-encrypted",
            summary: [{ type: "summary_text", text: "Synthetic reasoning" }],
          }),
        };
  const prefix = [
    { role: "user", content: "Synthetic channel A task. ".repeat(300), timestamp: 1 },
    assistant(
      [
        signedThinking,
        { type: "toolCall", id: "call_note", name: "read_note", arguments: { path: "note.txt" } },
      ],
      "toolUse",
    ),
    {
      role: "toolResult",
      toolCallId: "call_note",
      toolName: "read_note",
      content: [{ type: "text", text: "Synthetic result. ".repeat(200) }],
      isError: false,
      timestamp: 3,
    },
    assistant([{ type: "text", text: "First task recorded." }]),
  ];
  const history = [
    ...prefix,
    { role: "user", content: "Synthetic channel B task.", timestamp: 5 },
    assistant([{ type: "text", text: "Second task recorded." }]),
  ];
  const context = {
    systemPrompt: "You are a persistent Mate Agent.",
    tools: declarations,
    messages: history,
  };
  const base = await captureRequestPayload(model, context);
  const instruction = {
    role: "user",
    content: "Summarize the preceding material only. Produce text, do not call tools.",
    timestamp: 6,
  };
  const appended = await captureRequestPayload(model, {
    ...context,
    messages: [...history, instruction],
  });
  const sliced = await captureRequestPayload(model, {
    ...context,
    messages: [...prefix, instruction],
  });
  const summaryOnlyPayload = await captureRequestPayload(
    model,
    {
      systemPrompt: "You are a context summarizer.",
      messages: [
        {
          ...instruction,
          content: `<conversation>${JSON.stringify(prefix)}</conversation>\nSummarize.`,
        },
      ],
    },
    { cacheRetention: "none", sessionId: "separate-summary-session" },
  );
  const baseItems = withoutCacheMarkers(base.input ?? base.messages);
  const appendedItems = withoutCacheMarkers(appended.input ?? appended.messages);
  const slicedItems = withoutCacheMarkers(sliced.input ?? sliced.messages);
  assert.deepEqual(appendedItems.slice(0, baseItems.length), baseItems);
  assert.deepEqual(slicedItems.slice(0, -1), baseItems.slice(0, slicedItems.length - 1));
  assert.deepEqual(withoutCacheMarkers(base.tools), withoutCacheMarkers(appended.tools));
  assert.deepEqual(withoutCacheMarkers(base.tools), withoutCacheMarkers(sliced.tools));
  assert.deepEqual(withoutCacheMarkers(base.system), withoutCacheMarkers(appended.system));
  assert.deepEqual(base.reasoning, appended.reasoning);
  assert.deepEqual(base.thinking, appended.thinking);
  assert.ok(base.reasoning || base.thinking);
  assert.deepEqual(base.reasoning, sliced.reasoning);
  assert.deepEqual(base.thinking, sliced.thinking);
  assert.deepEqual(withoutCacheMarkers(base.system), withoutCacheMarkers(sliced.system));
  const serialized = JSON.stringify(slicedItems);
  assert.ok(
    serialized.includes("synthetic-signature") || serialized.includes("synthetic-encrypted"),
  );
  assert.ok(serialized.includes("call_note"));
  assert.ok(!summaryOnlyPayload.tools || summaryOnlyPayload.tools.length === 0);
  comparisons.push({
    provider,
    model: id,
    api: model.api,
    appendPreservesRequestItems: true,
    slicePreservesRetainedPrefixItems: true,
    toolsPreserved: true,
    signaturesAndCallIdsPreserved: true,
    comparedPrefixItems: slicedItems.length - 1,
    ignoredOnly: "cache_control placement metadata; no content/signatures omitted",
    piStyleUsesDifferentSystemAndNoTools: true,
    limitation:
      "Synthetic structured payloads only; no server acceptance, cache hit or summary-quality measurement",
  });
}
assert.equal(fetchCalls, 0);
const result = { piVersion: "0.86.0", fetchCalls, rows: comparisons };
console.log(JSON.stringify(result, null, 2));
