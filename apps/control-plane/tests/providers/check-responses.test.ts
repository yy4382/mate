import { expect, it } from "vitest";

import { respond } from "../support/agent/agent-loop.js";
import { checkProviderProtocol } from "../../src/providers/active-check.js";
import { withProvider, text } from "../support/provider/protocol-fixture.js";

it("synthetic HTTP/SSE exercises the real Pi text, harmless tool and associated result continuation", async () => {
  await withProvider(
    (request, response, index) => {
      if (index === 0) text(response, "短文本");
      else if (index === 1) respond(response, [{ name: "mate_protocol_probe", input: {} }]);
      else
        text(
          response,
          request.input.find((item) => item.type === "function_call_output")?.output ?? "missing",
        );
    },
    async (baseUrl, requests) => {
      const result = await checkProviderProtocol(
        { provider: "openai", modelId: "gpt-4o-mini", apiKey: "synthetic-not-a-real-key" },
        { modelForCheck: (model) => ({ ...model, baseUrl }) },
      );
      expect(result.status).toBe("passed");
      expect(result.connection).toBe("synthetic");
      expect(result.observed).toEqual({
        textStream: true,
        textCompleted: true,
        toolExecuted: true,
        toolCallAssociated: true,
        continuationCompleted: true,
        toolResultAcknowledged: true,
      });
      expect(requests).toHaveLength(3);
      expect(requests[1]?.tools?.map((tool) => tool.name)).toEqual(["mate_protocol_probe"]);
      expect(requests[2]?.input.find((item) => item.type === "function_call_output")).toMatchObject(
        {
          call_id: "call_0",
          output: expect.stringMatching(/^mate-probe-[0-9a-f-]+$/),
        },
      );
      expect(JSON.stringify(result)).not.toContain("synthetic-not-a-real-key");
      expect(JSON.stringify(result)).not.toContain("mate-probe-");
    },
  );
});

it.each(["no_tool", "no_acknowledgement", "repeat_tool"])(
  "model choice %s remains unverified instead of failing the harness",
  async (choice) => {
    await withProvider(
      (_request, response, index) => {
        if ((index === 1 && choice !== "no_tool") || (index === 2 && choice === "repeat_tool"))
          respond(response, [{ name: "mate_protocol_probe", input: {} }]);
        else text(response, "synthetic response without the tool marker");
      },
      async (baseUrl, requests) => {
        const result = await checkProviderProtocol(
          { provider: "openai", modelId: "gpt-4o-mini", apiKey: "synthetic-key" },
          { modelForCheck: (model) => ({ ...model, baseUrl }) },
        );
        expect(result.status).toBe("unverified");
        expect(result.reason).toBe(
          choice === "no_tool"
            ? "tool_not_observed"
            : choice === "repeat_tool"
              ? "additional_tool_call"
              : "tool_result_not_acknowledged",
        );
        expect(requests).toHaveLength(choice === "no_tool" ? 2 : 3);
      },
    );
  },
);

it("a truncated stream cannot count as a completed text check or dispatch a tool", async () => {
  await withProvider(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            id: "msg_partial",
            role: "assistant",
            content: [{ type: "output_text", text: "partial", annotations: [] }],
          },
        })}\n\n`,
      );
    },
    async (baseUrl, requests) => {
      const result = await checkProviderProtocol(
        { provider: "openai", modelId: "gpt-4o-mini", apiKey: "synthetic-key" },
        { modelForCheck: (model) => ({ ...model, baseUrl }) },
      );
      expect(result).toMatchObject({ status: "failed", reason: "provider_error" });
      expect(result.observed.textCompleted).toBe(false);
      expect(result.observed.toolExecuted).toBe(false);
      expect(requests).toHaveLength(1);
    },
  );
});

it.each(["owner", "timeout"])(
  "%s cancellation stops a pending real HTTP request with minimal diagnostics",
  async (cause) => {
    const controller = new AbortController();
    await withProvider(
      () => {
        if (cause === "owner") controller.abort();
      },
      async (baseUrl, requests) => {
        const result = await checkProviderProtocol(
          {
            provider: "openai",
            modelId: "gpt-4o-mini",
            apiKey: "synthetic-key",
            signal: controller.signal,
            timeoutMs: 250,
          },
          { modelForCheck: (model) => ({ ...model, baseUrl }) },
        );
        expect(result).toMatchObject({
          status: "unverified",
          reason: cause === "owner" ? "owner_cancelled" : "timeout",
          stage: "text",
        });
        expect(result.observed.toolExecuted).toBe(false);
        expect(requests).toHaveLength(1);
      },
    );
  },
);

it.each(["[]", '\"\"', "0", '{"unexpected":true}'])(
  "rejects malformed protocol probe arguments %s before producing a tool result",
  async (argumentsJson) => {
    await withProvider(
      (request, response, index) => {
        if (index === 0) text(response, "短文本");
        else if (index === 1) {
          const item = {
            type: "function_call",
            id: "invalid-probe",
            call_id: "invalid-probe",
            name: "mate_protocol_probe",
            arguments: argumentsJson,
            status: "completed",
          };
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n` +
              `data: ${JSON.stringify({ type: "response.completed", response: { id: "invalid-probe-response", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}\n\n`,
          );
        } else
          text(
            response,
            request.input.find((item) => item.type === "function_call_output")?.output ?? "missing",
          );
      },
      async (baseUrl, requests) => {
        const result = await checkProviderProtocol(
          { provider: "openai", modelId: "gpt-4o-mini", apiKey: "synthetic-key" },
          { modelForCheck: (model) => ({ ...model, baseUrl }) },
        );
        expect(result).toMatchObject({
          status: "unverified",
          reason: "tool_not_observed",
          stage: "tool",
        });
        expect(result.observed.toolExecuted).toBe(false);
        expect(result.observed.toolCallAssociated).toBe(false);
        expect(requests).toHaveLength(2);
      },
    );
  },
);
