import { expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { respond } from "../helpers/agent-loop.js";
import { checkProviderProtocol } from "../../src/providers/active-check.js";

const requestSchema = z.looseObject({
  input: z.array(
    z.looseObject({
      type: z.string().optional(),
      call_id: z.string().optional(),
      output: z.string().optional(),
    }),
  ),
  tools: z.array(z.looseObject({ name: z.string() })).optional(),
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
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = requestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
    requests.push(payload);
    handle(payload, response, requests.length - 1);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No synthetic provider port");
    await run(`http://127.0.0.1:${address.port}/v1`, requests);
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

it.each(["no_tool", "no_acknowledgement"])(
  "model choice %s remains unverified instead of failing the harness",
  async (choice) => {
    await withProvider(
      (_request, response, index) => {
        if (index === 1 && choice !== "no_tool")
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
          choice === "no_tool" ? "tool_not_observed" : "tool_result_not_acknowledged",
        );
        expect(requests).toHaveLength(choice === "no_tool" ? 2 : 3);
      },
    );
  },
);

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
