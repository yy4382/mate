import { expect, it } from "vitest";

import { z } from "zod";

import { checkProviderProtocol } from "../../src/providers/active-check.js";
import {
  withProvider,
  anthropicReply,
  completionsReply,
} from "../support/provider/protocol-fixture.js";

it("a refusal reason in an incomplete Anthropic stream is still a protocol failure", async () => {
  await withProvider(
    (_request, response, index) =>
      anthropicReply(
        response,
        index === 0
          ? { text: "短文本" }
          : { text: "private refusal explanation", stopReason: "refusal" },
        index === 0 ? "message_stop" : "eof",
      ),
    async (baseUrl) => {
      const result = await checkProviderProtocol(
        { provider: "anthropic", modelId: "claude-sonnet-4-5", apiKey: "synthetic-key" },
        { modelForCheck: (model) => ({ ...model, baseUrl: baseUrl.replace(/\/v1$/, "") }) },
      );
      expect(result).toMatchObject({ status: "failed", reason: "provider_error", stage: "tool" });
      expect(result.observed.toolExecuted).toBe(false);
    },
  );
});

it.each(z.enum(["error", "malformed"]).options)(
  "an Anthropic refusal followed by %s must retain the actual protocol failure",
  async (ending) => {
    await withProvider(
      (_request, response, index) =>
        anthropicReply(
          response,
          index === 0
            ? { text: "短文本" }
            : { text: "private refusal explanation", stopReason: "refusal" },
          index === 0 ? "message_stop" : ending,
        ),
      async (baseUrl, requests) => {
        const result = await checkProviderProtocol(
          { provider: "anthropic", modelId: "claude-sonnet-4-5", apiKey: "synthetic-key" },
          { modelForCheck: (model) => ({ ...model, baseUrl: baseUrl.replace(/\/v1$/, "") }) },
        );
        expect(result).toMatchObject({ status: "failed", reason: "provider_error", stage: "tool" });
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(result)).not.toMatch(
          /private provider error|private refusal explanation/,
        );
      },
    );
  },
);

it.each(["refusal", "sensitive"])(
  "a valid model %s through the real Anthropic adapter is unverified rather than a transport failure",
  async (stopReason) => {
    await withProvider(
      (_request, response, index) =>
        anthropicReply(
          response,
          index === 1 ? { text: "private refusal explanation", stopReason } : { text: "短文本" },
        ),
      async (baseUrl, requests) => {
        const result = await checkProviderProtocol(
          { provider: "anthropic", modelId: "claude-sonnet-4-5", apiKey: "synthetic-key" },
          { modelForCheck: (model) => ({ ...model, baseUrl: baseUrl.replace(/\/v1$/, "") }) },
        );
        expect(result).toMatchObject({
          status: "unverified",
          reason: "model_declined",
          stage: "tool",
          httpStatus: 200,
        });
        expect(result.observed.textCompleted).toBe(true);
        expect(result.observed.toolExecuted).toBe(false);
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(result)).not.toContain("private refusal explanation");
      },
    );
  },
);

it("Anthropic result continuation keeps its tool declaration and the actual tool-use ID", async () => {
  await withProvider(
    (request, response, index) => {
      if (index === 0) anthropicReply(response, { text: "短文本" });
      else if (index === 1) anthropicReply(response, { callId: "probe_call" });
      else {
        const resultBlocks = z
          .array(
            z.looseObject({
              type: z.string(),
              content: z
                .union([
                  z.string(),
                  z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
                ])
                .optional(),
            }),
          )
          .parse(request.messages?.findLast((message) => message.role === "user")?.content);
        const result = resultBlocks.find((block) => block.type === "tool_result");
        anthropicReply(response, {
          text:
            typeof result?.content === "string"
              ? result.content
              : (result?.content?.[0]?.text ?? "missing tool result"),
        });
      }
    },
    async (baseUrl, requests) => {
      const result = await checkProviderProtocol(
        { provider: "anthropic", modelId: "claude-sonnet-4-5", apiKey: "synthetic-key" },
        { modelForCheck: (model) => ({ ...model, baseUrl: baseUrl.replace(/\/v1$/, "") }) },
      );
      expect(result.status).toBe("passed");
      expect(result.connection).toBe("synthetic");
      expect(requests[2]?.tools?.map((tool) => tool.name)).toEqual(["mate_protocol_probe"]);
      expect(requests[2]?.messages).toContainEqual(
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "tool_result",
              tool_use_id: "probe_call",
            }),
          ]),
        }),
      );
    },
  );
});

it.each(["empty", "missing"])(
  "an %s tool call ID through the real Chat Completions adapter cannot verify association",
  async (idKind) => {
    await withProvider(
      (request, response, index) => {
        const delta =
          index === 1
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    ...(idKind === "empty" ? { id: "" } : {}),
                    type: "function",
                    function: { name: "mate_protocol_probe", arguments: "{}" },
                  },
                ],
              }
            : {
                role: "assistant",
                content:
                  index === 0
                    ? "短文本"
                    : request.messages?.find((message) => message.role === "tool")?.content,
              };
        completionsReply(response, delta, index === 1 ? "tool_calls" : "stop");
      },
      async (baseUrl, requests) => {
        const result = await checkProviderProtocol(
          { provider: "deepseek", modelId: "deepseek-flash", apiKey: "synthetic-key" },
          { modelForCheck: (model) => ({ ...model, baseUrl }) },
        );
        expect(result).toMatchObject({ status: "failed", reason: "tool_call_not_associated" });
        expect(result.observed.toolCallAssociated).toBe(false);
        expect(result.observed.continuationCompleted).toBe(false);
        expect(requests).toHaveLength(2);
      },
    );
  },
);
