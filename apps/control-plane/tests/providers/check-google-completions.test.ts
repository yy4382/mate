import { expect, it } from "vitest";

import { checkProviderProtocol } from "../../src/providers/active-check.js";
import { withProvider, completionsReply } from "../support/provider/protocol-fixture.js";

it.each(["SAFETY", "BLOCKLIST"])(
  "a complete Google %s model decline remains unverified",
  async (finishReason) => {
    await withProvider(
      (_request, response, index) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            candidates: [
              {
                content: { role: "model", parts: [{ text: "短文本" }] },
                finishReason: index === 0 ? "STOP" : finishReason,
              },
            ],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
          })}\n\n`,
        );
      },
      async (baseUrl, requests) => {
        const result = await checkProviderProtocol(
          { provider: "google", modelId: "gemini-2.5-flash", apiKey: "synthetic-key" },
          { modelForCheck: (model) => ({ ...model, baseUrl }) },
        );
        expect(result).toMatchObject({
          status: "unverified",
          reason: "model_declined",
          stage: "tool",
        });
        expect(result.observed.toolExecuted).toBe(false);
        expect(requests).toHaveLength(2);
      },
    );
  },
);

it("a Google decline followed by malformed SSE remains a protocol failure", async () => {
  await withProvider(
    (_request, response, index) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: { role: "model", parts: [{ text: "短文本" }] },
              finishReason: index === 0 ? "STOP" : "SAFETY",
            },
          ],
        })}\n\n`,
      );
      response.end(index === 0 ? "" : "data: {invalid-json}\n\n");
    },
    async (baseUrl) => {
      const result = await checkProviderProtocol(
        { provider: "google", modelId: "gemini-2.5-flash", apiKey: "synthetic-key" },
        { modelForCheck: (model) => ({ ...model, baseUrl }) },
      );
      expect(result).toMatchObject({ status: "failed", reason: "provider_error", stage: "tool" });
    },
  );
});

it("mixed continuation text and a repeated Chat Completions tool call cannot pass even with a stop finish reason", async () => {
  await withProvider(
    (request, response, index) => {
      const content =
        index === 0
          ? "短文本"
          : request.messages?.find((message) => message.role === "tool")?.content;
      const delta = {
        role: "assistant",
        ...(index !== 1 ? { content } : {}),
        ...(index > 0
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: `probe_call_${index}`,
                  type: "function",
                  function: { name: "mate_protocol_probe", arguments: "{}" },
                },
              ],
            }
          : {}),
      };
      completionsReply(response, delta, index === 1 ? "tool_calls" : "stop");
    },
    async (baseUrl, requests) => {
      const result = await checkProviderProtocol(
        { provider: "deepseek", modelId: "deepseek-flash", apiKey: "synthetic-key" },
        { modelForCheck: (model) => ({ ...model, baseUrl }) },
      );
      expect(result).toMatchObject({ status: "unverified", reason: "additional_tool_call" });
      expect(requests).toHaveLength(3);
    },
  );
});

it("a normally terminated Chat Completions content filter remains a model choice", async () => {
  await withProvider(
    (_request, response, index) =>
      completionsReply(
        response,
        { role: "assistant", content: "短文本" },
        index === 0 ? "stop" : "content_filter",
      ),
    async (baseUrl, requests) => {
      const result = await checkProviderProtocol(
        { provider: "deepseek", modelId: "deepseek-flash", apiKey: "synthetic-key" },
        { modelForCheck: (model) => ({ ...model, baseUrl }) },
      );
      expect(result).toMatchObject({
        status: "unverified",
        reason: "model_declined",
        stage: "tool",
        httpStatus: 200,
      });
      expect(result.observed.toolExecuted).toBe(false);
      expect(requests).toHaveLength(2);
    },
  );
});
