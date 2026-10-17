import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

const requestBodySchema = z.looseObject({
  model: z.string(),
  input: z.array(z.unknown()),
  instructions: z.string().optional(),
  tools: z.array(z.looseObject({ type: z.string(), name: z.string().optional() })).optional(),
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

type RequestBody = z.output<typeof requestBodySchema>;

/** What a request asked of the model: readers over its body, with no way to answer it. */
export class ScriptedRequestBody {
  readonly body: RequestBody;

  constructor(body: RequestBody) {
    this.body = body;
  }

  /** The text of every user-role message in the request, oldest first. */
  userTexts(): string[] {
    return this.#messageTexts((role) => role === "user");
  }

  /**
   * The system text the model sees, in order: `instructions` if present, then every system- or developer-role input
   * item. Durable puts an Agent's prompt sections in input items, not in `instructions`.
   */
  systemTexts(): string[] {
    return [
      ...(this.body.instructions === undefined ? [] : [this.body.instructions]),
      ...this.#messageTexts((role) => role === "system" || role === "developer"),
    ];
  }

  /** The names of the tools this request offered, in order. */
  toolNames(): string[] {
    return (this.body.tools ?? []).flatMap((tool) => (tool.name === undefined ? [] : [tool.name]));
  }

  /** The output the client sent back for the tool call with `callId`, or undefined. */
  toolOutput(callId: string): string | undefined {
    for (const item of this.body.input) {
      const parsed = functionCallOutputSchema.safeParse(item);
      if (parsed.success && parsed.data.call_id === callId) return outputText(parsed.data.output);
    }
    return undefined;
  }

  /** Every tool output in the request, in order. */
  toolOutputs(): string[] {
    return this.body.input.flatMap((item) => {
      const parsed = functionCallOutputSchema.safeParse(item);
      return parsed.success ? [outputText(parsed.data.output)] : [];
    });
  }

  #messageTexts(role: (role: string) => boolean): string[] {
    return this.body.input.flatMap((item) => {
      const parsed = messageItemSchema.safeParse(item);
      if (!parsed.success || !role(parsed.data.role)) return [];
      const { content } = parsed.data;
      return typeof content === "string"
        ? [content]
        : content.flatMap((part) => (part.text === undefined ? [] : [part.text]));
    });
  }
}

/** One HTTP request the model client made, handed to the step that answers it. */
export class ScriptedRequest extends ScriptedRequestBody {
  #answered = false;
  #expectsCancellation = false;
  readonly #cancelled = Promise.withResolvers<void>();
  readonly #response: ServerResponse;
  /** The lane whose step answers this request. */
  readonly lane: string;
  readonly step: string;
  /** The API key the request was sent with: its bearer token, if it had one. */
  readonly apiKey: string | undefined;

  constructor(
    lane: string,
    step: string,
    body: RequestBody,
    response: ServerResponse,
    onFailure: (reason: string) => void,
    apiKey?: string,
  ) {
    super(body);
    this.lane = lane;
    this.step = step;
    this.apiKey = apiKey;
    this.#response = response;
    response.once("close", () => {
      if (this.#answered) return;
      this.#answered = true;
      if (this.#expectsCancellation) this.#cancelled.resolve();
      else
        onFailure(
          `lane ${lane}, step ${step}: client closed the request before the step answered it`,
        );
    });
  }

  /** Answer with a text; `truncated` ends it as cut off at the output token limit. */
  text(text: string, options: { inputTokens?: number; truncated?: boolean } = {}): void {
    const content = [{ type: "output_text", text, annotations: [] }];
    const item = {
      type: "message",
      id: `msg_${this.step}`,
      role: "assistant",
      status: options.truncated === true ? "incomplete" : "completed",
      content,
    };
    this.#complete([item], options.inputTokens, options.truncated === true);
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

  /** Start streaming a tool call and never finish it; the client must cancel. Resolves once it does. */
  partialCall(name: string, argumentsPrefix: string): Promise<void> {
    this.#startStream();
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
    return this.#cancelled.promise;
  }

  /** Start streaming a text answer and never finish it; the client must cancel. Resolves once it does. */
  partialText(prefix: string): Promise<void> {
    this.#startStream();
    const item = { type: "message", id: `msg_${this.step}`, role: "assistant", content: [] };
    this.#write({ type: "response.output_item.added", output_index: 0, item });
    this.#write({
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    this.#write({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: prefix,
    });
    return this.#cancelled.promise;
  }

  /** Never answer; the client must cancel. Resolves once it does. */
  hang(): Promise<void> {
    this.#expectsCancellation = true;
    return this.#cancelled.promise;
  }

  /** Fail with an HTTP error, typed as OpenAI types it: a 5xx is a server error, which clients retry; a 4xx is not. */
  status(code: number, message = "scripted failure"): void {
    this.#answered = true;
    const type = code >= 500 ? "server_error" : "invalid_request_error";
    this.#response.writeHead(code, { "content-type": "application/json" });
    this.#response.end(JSON.stringify({ error: { message, type, code: String(code) } }));
  }

  #complete(output: readonly unknown[], inputTokens = 50, truncated = false): void {
    if (this.#answered) throw new Error(`step ${this.step} already answered`);
    this.#answered = true;
    this.#response.writeHead(200, { "content-type": "text/event-stream" });
    output.forEach((item, index) =>
      this.#write({ type: "response.output_item.done", output_index: index, item }),
    );
    this.#write({
      type: truncated ? "response.incomplete" : "response.completed",
      response: {
        id: `resp_${this.step}`,
        ...(truncated
          ? { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }
          : { status: "completed" }),
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

  #startStream(): void {
    this.#expectsCancellation = true;
    this.#response.writeHead(200, { "content-type": "text/event-stream" });
  }

  #write(event: unknown): void {
    this.#response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

export type ScriptedStep = (request: ScriptedRequest) => void | Promise<void>;

/** Decides, from its first request, whether a conversation belongs to a lane. */
export type ScriptedClaim = (request: ScriptedRequestBody) => boolean;

/** Requests in arrival order, with a way to wait for the count to reach a number. */
class RequestLog {
  readonly requests: ScriptedRequest[] = [];
  readonly #waiters: { count: number; resolve: () => void }[] = [];

  /** Resolve once `count` requests have arrived. */
  received(count: number): Promise<void> {
    if (this.requests.length >= count) return Promise.resolve();
    const waiter = Promise.withResolvers<void>();
    this.#waiters.push({ count, resolve: waiter.resolve });
    return waiter.promise;
  }

  protected record(request: ScriptedRequest): void {
    this.requests.push(request);
    for (const waiter of this.#waiters.filter((item) => item.count <= this.requests.length))
      waiter.resolve();
  }
}

/**
 * The script for one conversation of the Agent: its steps, answered in order, and the requests it received. A lane is
 * bound to a conversation by the request's `prompt_cache_key`, which Durable keeps stable per conversation.
 */
export class ScriptedLane extends RequestLog {
  readonly name: string;
  readonly #claim: ScriptedClaim | undefined;
  readonly #steps: { name: string; run: ScriptedStep }[] = [];

  constructor(name: string, claim?: ScriptedClaim) {
    super();
    this.name = name;
    this.#claim = claim;
  }

  step(name: string, run: ScriptedStep): this {
    this.#steps.push({ name, run });
    return this;
  }

  claims(request: ScriptedRequestBody): boolean {
    return this.#claim?.(request) ?? true;
  }

  /** Take the next step, and the request it answers onto this lane's log. */
  take(
    answer: (step: string) => ScriptedRequest,
  ): { request: ScriptedRequest; run: ScriptedStep } | undefined {
    const next = this.#steps.shift();
    if (next === undefined) return undefined;
    const request = answer(next.name);
    this.record(request);
    return { request, run: next.run };
  }

  unusedSteps(): string[] {
    return this.#steps.map((step) => step.name);
  }
}

/**
 * A local model provider speaking the OpenAI Responses protocol over real HTTP and SSE.
 *
 * Each conversation of the Agent (the primary conversation, each work assistant) has its own lane of named steps, so
 * concurrent conversations cannot steal each other's steps. `step()` scripts the default lane, which takes the first
 * conversation no declared lane claims; `lane(name, claim)` declares another, which takes the first conversation whose
 * first request `claim` accepts. A request without a conversation key, such as a summary request, is claimed by itself
 * and leaves its lane free to claim the next one. Anything unplanned (an unclaimed request, a request after its lane's
 * script ran out, an undeclared cancel) is recorded and fails `assertComplete()`, naming the lane and step.
 */
export class ScriptedProvider extends RequestLog {
  readonly #default = new ScriptedLane("default");
  readonly #lanes: ScriptedLane[] = [];
  /** Each conversation's lane, by `prompt_cache_key`. */
  readonly #bound = new Map<string, ScriptedLane>();
  readonly #failures: string[] = [];
  readonly #server = createServer((request, response) => void this.#handle(request, response));

  private constructor() {
    super();
  }

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

  /** Add a step to the default lane. */
  step(name: string, run: ScriptedStep): this {
    this.#default.step(name, run);
    return this;
  }

  /** Declare a lane for the first conversation whose first request `claim` accepts. Lanes are tried in order. */
  lane(name: string, claim: ScriptedClaim): ScriptedLane {
    const lane = new ScriptedLane(name, claim);
    this.#lanes.push(lane);
    return lane;
  }

  assertComplete(): void {
    const problems = [
      ...this.#failures,
      ...[this.#default, ...this.#lanes].flatMap((lane) =>
        lane.unusedSteps().map((step) => `lane ${lane.name}, step ${step}: never requested`),
      ),
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
    const apiKey = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    const next = parsed.success
      ? this.#plan(parsed.data, response, apiKey)
      : "a request body was not a Responses request";
    if (typeof next === "string") {
      this.#failures.push(next);
      unscripted(response);
      return;
    }
    this.record(next.request);
    try {
      await next.run(next.request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#failures.push(`lane ${next.request.lane}, step ${next.request.step}: threw ${message}`);
      if (!response.headersSent) unscripted(response);
    }
  }

  /**
   * Find the lane that owns the request's conversation and take its next step, or say why there is none. A request
   * without a `prompt_cache_key`, such as Durable's summary request, belongs to no conversation: each one is claimed
   * on its own and binds no lane.
   */
  #plan(body: RequestBody, response: ServerResponse, apiKey: string | undefined) {
    const key = body.prompt_cache_key;
    const request = new ScriptedRequestBody(body);
    const taken = new Set(this.#bound.values());
    const lane =
      (key === undefined ? undefined : this.#bound.get(key)) ??
      [...this.#lanes, this.#default].find((each) => !taken.has(each) && each.claims(request));
    if (lane === undefined)
      return `a request from an unclaimed conversation (first user text ${JSON.stringify(request.userTexts()[0])})`;
    if (key !== undefined) this.#bound.set(key, lane);
    const failed = (reason: string) => this.#failures.push(reason);
    return (
      lane.take((step) => new ScriptedRequest(lane.name, step, body, response, failed, apiKey)) ??
      `lane ${lane.name}: a request arrived after its script ran out`
    );
  }
}

function outputText(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

/**
 * Answer a request the script did not plan for. A 4xx is not retried, so the failure ends the run at once and shows
 * up in `assertComplete()`, instead of a retry storm that turns into a timeout.
 */
function unscripted(response: ServerResponse): void {
  response.writeHead(400, { "content-type": "application/json" });
  response.end(
    JSON.stringify({ error: { message: "unscripted request", type: "invalid_request_error" } }),
  );
}
