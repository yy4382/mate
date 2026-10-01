import { describe, expect, it } from "vitest";
import { providerResponseComplete, reportedUsage } from "../../src/runtime/provider-response.js";

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
});
