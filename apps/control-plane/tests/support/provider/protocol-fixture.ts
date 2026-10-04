import { expect } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";

import { resolve } from "node:path";

export const requestSchema = z.looseObject({
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
export async function withProvider(
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
export function text(response: ServerResponse, value: string) {
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
export function anthropicReply(
  response: ServerResponse,
  reply: { text: string; stopReason?: string } | { callId: string },
  ending: "message_stop" | "eof" | "error" | "malformed" = "message_stop",
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
    if (event.type === "message_stop" && ending !== "message_stop") continue;
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  if (ending === "error")
    response.write(
      `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "private provider error after refusal" } })}\n\n`,
    );
  if (ending === "malformed") response.write("data: {invalid-json}\n\n");
  response.end();
}
export function completionsReply(
  response: ServerResponse,
  delta: Record<string, unknown>,
  finishReason: "stop" | "tool_calls" | "content_filter",
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
