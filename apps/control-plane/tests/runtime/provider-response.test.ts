import { describe, expect, it } from "vitest";
import {
  inspectProviderResponse,
  providerResponseComplete,
  reportedUsage,
} from "../../src/runtime/provider-response.js";

function interruptedResponse(status: number, chunks: string[]) {
  let index = 0;
  return new Response(
    new ReadableStream({
      async pull(controller) {
        const chunk = chunks[index++];
        if (chunk !== undefined) controller.enqueue(new TextEncoder().encode(chunk));
        else {
          // Let the clone observe the received chunks before the transport fails.
          await new Promise((resolve) => setImmediate(resolve));
          controller.error(new Error("Synthetic interrupted response"));
        }
      },
    }),
    { status },
  );
}

describe("provider response observations", () => {
  it("keeps reported zero distinct from absent or malformed usage fields", () => {
    const body = [
      'data: {"response":{"usage":{"input_tokens":0,"output_tokens":2,"input_tokens_details":{"cached_tokens":0}}},"extension":{"keep":"opaque"}}',
      'data: {"usage":{"input_tokens":"9","output_tokens":-1}}',
      "data: {truncated",
    ].join("\n");
    expect(reportedUsage(body, "openai-responses")).toEqual({
      sourceApi: "openai-responses",
      inputBasis: "includes_cache",
      input: 0,
      output: 2,
      cacheRead: 0,
    });
  });

  it("accepts streamed provider envelopes and merges only actually reported values", () => {
    const body = [
      'data: {"message":{"usage":{"input_tokens":7,"cache_creation_input_tokens":3}}}',
      'data: {"usage":{"output_tokens":5,"cache_read_input_tokens":1}}',
    ].join("\n");
    expect(reportedUsage(body, "anthropic-messages")).toEqual({
      sourceApi: "anthropic-messages",
      inputBasis: "excludes_cache",
      input: 7,
      output: 5,
      cacheWrite: 3,
      cacheRead: 1,
    });
  });

  it("ignores malformed objects without inventing usage", () => {
    expect(
      reportedUsage('data: {"response":17,"usage":null}\ndata: {"usage":[]}', "custom"),
    ).toEqual({
      sourceApi: "custom",
      inputBasis: "unknown",
    });
  });

  it("requires terminal stream evidence rather than arbitrary complete JSON", () => {
    expect(providerResponseComplete('data: {"type":"response.completed"}', 200)).toBe(true);
    expect(providerResponseComplete('data: {"type":"message_stop"}', 200)).toBe(true);
    expect(providerResponseComplete("data: [DONE]", 200)).toBe(true);
    expect(providerResponseComplete('{"error":"not allowed"}', 403)).toBe(true);
    expect(providerResponseComplete('data: {"type":"response.created"}', 200)).toBe(false);
    expect(providerResponseComplete('data: {"type":17}', 200)).toBe(false);
    expect(providerResponseComplete('data: {"type":"response.completed"', 200)).toBe(false);
  });

  it.each([403, 503])("does not confirm interrupted HTTP %s error bodies", async (status) => {
    expect(
      await inspectProviderResponse(interruptedResponse(status, []), "openai-responses"),
    ).toBeNull();
    expect(
      await inspectProviderResponse(
        interruptedResponse(status, ['{"error":"part']),
        "openai-responses",
      ),
    ).toBeNull();
  });

  it("does not confirm an interrupted SSE event without its frame terminator", async () => {
    expect(
      await inspectProviderResponse(
        interruptedResponse(200, ['data: {"type":"response.failed"}']),
        "openai-responses",
      ),
    ).toBeNull();
  });

  it.each(["\n", "\r\n", "\r"])(
    "preserves a complete failed SSE frame after cancellation (newline=%j)",
    async (newline) => {
      expect(
        await inspectProviderResponse(
          interruptedResponse(200, [
            'data: {"type":"response.failed","response":{"usage":{"input_tokens":70,',
            '"output_tokens":3,"input_tokens_details":{"cached_tokens":7}}}}',
            newline,
            newline,
          ]),
          "openai-responses",
        ),
      ).toEqual({
        complete: true,
        usage: {
          sourceApi: "openai-responses",
          inputBasis: "includes_cache",
          input: 70,
          output: 3,
          cacheRead: 7,
        },
      });
    },
  );

  it("keeps missing usage unknown and discards an unfinished trailing frame after cancellation", async () => {
    expect(
      await inspectProviderResponse(
        interruptedResponse(200, [
          'data: {"type":"response.failed"}\n\n',
          'data: {"usage":{"input_tokens":999}}',
        ]),
        "openai-responses",
      ),
    ).toEqual({
      complete: true,
      usage: { sourceApi: "openai-responses", inputBasis: "includes_cache" },
    });
  });
});
