import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

const requestBodySchema = z.looseObject({
  model: z.string(),
  input: z.array(z.unknown()),
  prompt_cache_key: z.string().optional(),
});

const functionCallOutputSchema = z.looseObject({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: z.unknown(),
});

const messageItemSchema = z.looseObject({
  role: z.string(),
  content: z.union([
    z.string(),
    z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  ]),
});

export type ScriptedToolCall = { readonly name: string; readonly arguments: unknown };

type Outcome =
  | { readonly kind: "pending" }
  | { readonly kind: "responded" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly reason: string };

/** One HTTP request the model client made, handed to the step that answers it. */
export class ScriptedRequest {
  #outcome: Outcome = { kind: "pending" };
  #expectsCancellation = false;
  readonly #cancelled = Promise.withResolvers<void>();
  readonly #response: ServerResponse;
  readonly #onFailure: (reason: string) => void;
  readonly step: string;
  readonly body: z.output<typeof requestBodySchema>;

  constructor(
    step: string,
    body: z.output<typeof requestBodySchema>,
    response: ServerResponse,
    onFailure: (reason: string) => void,
  ) {
    this.step = step;
    this.body = body;
    this.#response = response;
    this.#onFailure = onFailure;
    response.once("close", () => {
      if (this.#outcome.kind !== "pending") return;
      if (this.#expectsCancellation) {
        this.#outcome = { kind: "cancelled" };
        this.#cancelled.resolve();
        return;
      }
      this.#fail("client closed the request before the step answered it");
    });
  }

  get outcome(): Outcome["kind"] {
    return this.#outcome.kind;
  }

  /** The text of every user-role message in the request, oldest first. */
  userTexts(): string[] {
    return this.body.input.flatMap((item) => {
      const parsed = messageItemSchema.safeParse(item);
      if (!parsed.success || parsed.data.role !== "user") return [];
      const { content } = parsed.data;
      return typeof content === "string"
        ? [content]
        : content.flatMap((part) => (part.text === undefined ? [] : [part.text]));
    });
  }

  /** The output the client sent back for the tool call with `callId`, or undefined. */
  toolOutput(callId: string): string | undefined {
    for (const item of this.body.input) {
      const parsed = functionCallOutputSchema.safeParse(item);
      if (parsed.success && parsed.data.call_id === callId) {
        const { output } = parsed.data;
        return typeof output === "string" ? output : JSON.stringify(output);
      }
    }
    return undefined;
  }

  /** Every tool output in the request, in order. */
  toolOutputs(): string[] {
    return this.body.input.flatMap((item) => {
      const parsed = functionCallOutputSchema.safeParse(item);
      if (!parsed.success) return [];
      const { output } = parsed.data;
      return [typeof output === "string" ? output : JSON.stringify(output)];
    });
  }

  text(text: string, options: { inputTokens?: number } = {}): void {
    this.#complete([messageItem(this.step, text)], options.inputTokens);
  }

  /** Answer with tool calls; each call ID is `<step>:<index>` so tests can find its output later. */
  call(calls: readonly ScriptedToolCall[], options: { inputTokens?: number } = {}): string[] {
    const ids = calls.map((_, index) => `${this.step}:${index}`);
    this.#complete(
      calls.map((call, index) => ({
        type: "function_call",
        id: `fc_${this.step}_${index}`,
        call_id: ids[index],
        name: call.name,
        arguments: JSON.stringify(call.arguments),
        status: "completed",
      })),
      options.inputTokens,
    );
    return ids;
  }

  /** Start streaming a tool call and never finish it; the client must cancel. */
  partialCall(name: string, argumentsPrefix: string): void {
    this.#expectsCancellation = true;
    this.#response.writeHead(200, { "content-type": "text/event-stream" });
    const item = {
      type: "function_call",
      id: `fc_${this.step}`,
      call_id: this.step,
      name,
      arguments: "",
    };
    this.#write({ type: "response.output_item.added", output_index: 0, item });
    this.#write({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: argumentsPrefix,
    });
  }

  /** Never answer; the client must cancel. Resolves once it does. */
  hang(): Promise<void> {
    this.#expectsCancellation = true;
    return this.#cancelled.promise;
  }

  /** Declare that the client will cancel this request, and wait for it. */
  cancelled(): Promise<void> {
    this.#expectsCancellation = true;
    return this.#cancelled.promise;
  }

  status(code: number, message = "scripted failure"): void {
    this.#outcome = { kind: "responded" };
    this.#response.writeHead(code, { "content-type": "application/json" });
    this.#response.end(
      JSON.stringify({ error: { message, type: "server_error", code: String(code) } }),
    );
  }

  #complete(output: readonly unknown[], inputTokens = 50): void {
    if (this.#outcome.kind !== "pending") throw new Error(`step ${this.step} already answered`);
    this.#outcome = { kind: "responded" };
    this.#response.writeHead(200, { "content-type": "text/event-stream" });
    output.forEach((item, index) =>
      this.#write({ type: "response.output_item.done", output_index: index, item }),
    );
    this.#write({
      type: "response.completed",
      response: {
        id: `resp_${this.step}`,
        status: "completed",
        output,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 10,
          total_tokens: inputTokens + 10,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
    this.#response.end();
  }

  #write(event: unknown): void {
    this.#response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  #fail(reason: string): void {
    this.#outcome = { kind: "failed", reason };
    this.#onFailure(`step ${this.step}: ${reason}`);
  }
}

export type ScriptedStep = (request: ScriptedRequest) => void | Promise<void>;

/**
 * A local model provider speaking the OpenAI Responses protocol over real HTTP and SSE. Tests queue named steps; each
 * incoming request takes the next step in order. Anything unplanned is recorded and fails `assertComplete()`.
 */
export class ScriptedProvider {
  readonly requests: ScriptedRequest[] = [];
  readonly #steps: { name: string; run: ScriptedStep }[] = [];
  readonly #failures: string[] = [];
  readonly #waiters: { count: number; resolve: () => void }[] = [];
  readonly #server = createServer((request, response) => void this.#handle(request, response));

  private constructor() {}

  static async start(): Promise<ScriptedProvider> {
    const provider = new ScriptedProvider();
    await new Promise<void>((resolve) => provider.#server.listen(0, "127.0.0.1", resolve));
    return provider;
  }

  /** Base URL to put on a pi-ai model in place of the real provider's. */
  get baseUrl(): string {
    const { port } = z
      .custom<AddressInfo>((value) => typeof value === "object" && value !== null)
      .parse(this.#server.address());
    return `http://127.0.0.1:${port}/v1`;
  }

  step(name: string, run: ScriptedStep): this {
    this.#steps.push({ name, run });
    return this;
  }

  /** Resolve once `count` requests have arrived in total. */
  received(count: number): Promise<void> {
    if (this.requests.length >= count) return Promise.resolve();
    const waiter = Promise.withResolvers<void>();
    this.#waiters.push({ count, resolve: waiter.resolve });
    return waiter.promise;
  }

  assertComplete(): void {
    const problems = [
      ...this.#failures,
      ...this.#steps.map((step) => `step ${step.name} was never requested`),
    ];
    if (problems.length > 0) throw new Error(`Scripted provider:\n- ${problems.join("\n- ")}`);
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const parsed = requestBodySchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const next = this.#steps.shift();
    if (!parsed.success || next === undefined) {
      this.#failures.push(
        next === undefined
          ? "a request arrived after the script was exhausted"
          : "a request body was not a Responses request",
      );
      response.writeHead(500).end();
      return;
    }
    const scripted = new ScriptedRequest(next.name, parsed.data, response, (reason) =>
      this.#failures.push(reason),
    );
    this.requests.push(scripted);
    for (const waiter of this.#waiters.filter((item) => item.count <= this.requests.length))
      waiter.resolve();
    try {
      await next.run(scripted);
    } catch (error) {
      this.#failures.push(
        `step ${next.name} threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!response.headersSent) response.writeHead(500).end();
    }
  }
}

function messageItem(step: string, text: string) {
  return {
    type: "message",
    id: `msg_${step}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}
