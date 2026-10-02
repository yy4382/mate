import { expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { respond } from "../helpers/agent-loop.js";
import { checkProviderProtocol } from "../../src/providers/active-check.js";

const requestSchema = z.looseObject({
  input: z
    .array(
      z.looseObject({
        type: z.string().optional(),
        call_id: z.string().optional(),
        output: z.string().optional(),
      }),
    )
    .default([]),
  messages: z.array(z.looseObject({ role: z.string(), content: z.unknown() })).optional(),
  tools: z
    .array(
      z.looseObject({
        name: z.string().optional(),
        function: z.looseObject({ name: z.string() }).optional(),
      }),
    )
    .optional(),
});

async function withProvider(
  handle: (
    request: z.output<typeof requestSchema>,
    response: ServerResponse,
    index: number,
  ) => void,
  run: (origin: string, requests: Array<z.output<typeof requestSchema>>) => Promise<void>,
) {
  const requests: Array<z.output<typeof requestSchema>> = [];
  const errors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
      requests.push(payload);
      handle(payload, response, requests.length - 1);
    } catch (error) {
      errors.push(error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Synthetic provider handler failed" } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No synthetic provider port");
    await run(`http://127.0.0.1:${address.port}/v1`, requests);
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function text(response: ServerResponse, value: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const item = {
    type: "message",
    id: "msg_check",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: value, annotations: [] }],
  };
  response.write(
    `data: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [] },
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: value })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`,
  );
  response.end(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp_check", status: "completed", output: [item] },
    })}\n\n`,
  );
}

function anthropicReply(
  response: ServerResponse,
  reply: { text: string; stopReason?: string } | { callId: string },
  complete = true,
) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_anthropic_check",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-sonnet-4-5",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block:
        "callId" in reply
          ? { type: "tool_use", id: reply.callId, name: "mate_protocol_probe", input: {} }
          : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta:
        "callId" in reply
          ? { type: "input_json_delta", partial_json: "{}" }
          : { type: "text_delta", text: reply.text },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: {
        stop_reason: "callId" in reply ? "tool_use" : (reply.stopReason ?? "end_turn"),
        stop_sequence: null,
      },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  ];
  for (const event of events) {
    if (event.type === "message_stop" && !complete) continue;
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

function completionsReply(
  response: ServerResponse,
  delta: Record<string, unknown>,
  finishReason: "stop" | "tool_calls",
) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [currentDelta, reason] of [
    [delta, null],
    [{}, finishReason],
  ]) {
    response.write(
      `data: ${JSON.stringify({
        id: "chatcmpl_check",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-flash",
        choices: [{ index: 0, delta: currentDelta, finish_reason: reason }],
      })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}

it("an owner check without an explicitly supplied credential remains unverified", async () => {
  const result = await checkProviderProtocol({ provider: "openai", modelId: "gpt-4o-mini" });
  expect(result.status).toBe("unverified");
  expect(result.reason).toBe("credential_missing");
  expect(result.observed).toEqual({
    textStream: false,
    textCompleted: false,
    toolExecuted: false,
    toolCallAssociated: false,
    continuationCompleted: false,
    toolResultAcknowledged: false,
  });
});

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

it("a refusal reason in an incomplete Anthropic stream is still a protocol failure", async () => {
  await withProvider(
    (_request, response, index) =>
      anthropicReply(
        response,
        index === 0
          ? { text: "短文本" }
          : { text: "private refusal explanation", stopReason: "refusal" },
        index === 0,
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
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "短文本" }] }, finishReason: index === 0 ? "STOP" : "SAFETY" }] })}\n\n`,
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

it("HTTP rejection records its status without retaining provider prose or credentials", async () => {
  await withProvider(
    (_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "private provider prose and synthetic-secret" } }),
      );
    },
    async (baseUrl, requests) => {
      const result = await checkProviderProtocol(
        { provider: "openai", modelId: "gpt-4o-mini", apiKey: "synthetic-secret" },
        { modelForCheck: (model) => ({ ...model, baseUrl }) },
      );
      expect(result).toMatchObject({
        status: "failed",
        reason: "provider_error",
        stage: "text",
        httpStatus: 401,
      });
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(result)).not.toMatch(/private provider prose|synthetic-secret/);
    },
  );
});

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

it("the owner CLI without a credential file ignores ambient API keys and reports a real check as unverified", async () => {
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      resolve("dist/providers/active-check-cli.js"),
      "--provider",
      "openai",
      "--model",
      "gpt-4o-mini",
    ],
    { env: { PATH: process.env.PATH, OPENAI_API_KEY: "ambient-secret-must-not-be-used" } },
  );
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({
    connection: "real",
    status: "unverified",
    reason: "credential_missing",
    stage: "configuration",
  });
  expect(stdout).not.toContain("ambient-secret-must-not-be-used");
});

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
