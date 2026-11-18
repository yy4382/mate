import { Type } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { defineExtension, defineTool, type Extension, type Tx } from "@earendil-works/pi-durable";
import { FaultyDatabase, ScriptedProvider, temporaryDirectory } from "@palace/testkit";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import {
  createAgentStore,
  openAgentRuntime,
  type AgentRuntime,
  type AgentSettings,
  type Clock,
  type CredentialsLookup,
  type RuntimeBackgroundTask,
} from "../src/index.ts";

export { FakeClock } from "@palace/testkit";

export const defaultSettings: AgentSettings = { model: { provider: "openai", modelId: "gpt-4.1" } };

export type PendingToolCall = {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal | undefined;
  resolve(text: string, isError?: boolean): void;
};

/** In-process controllable tool backend for runtime kernel boundary tests. */
export class FakeToolPort {
  readonly calls: { tool: string; args: Readonly<Record<string, unknown>> }[] = [];
  readonly #pending: PendingToolCall[] = [];
  readonly #arrivals: (() => void)[] = [];
  #autoAnswer: ((tool: string, args: Readonly<Record<string, unknown>>) => string) | undefined;

  answerAll(answer: (tool: string, args: Readonly<Record<string, unknown>>) => string): void {
    this.#autoAnswer = answer;
  }

  run(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
  ): Promise<{ content: [{ type: "text"; text: string }]; isError: boolean }> {
    this.calls.push({ tool, args });
    for (const arrived of this.#arrivals.splice(0)) arrived();
    if (this.#autoAnswer !== undefined) {
      return Promise.resolve({
        content: [{ type: "text", text: this.#autoAnswer(tool, args) }],
        isError: false,
      });
    }
    const { promise, resolve, reject } = Promise.withResolvers<{
      content: [{ type: "text"; text: string }];
      isError: boolean;
    }>();
    if (signal !== undefined) {
      const onAbort = () =>
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    this.#pending.push({
      tool,
      args,
      signal,
      resolve: (text, isError = false) => resolve({ content: [{ type: "text", text }], isError }),
    });
    return promise;
  }

  async nextCall(): Promise<PendingToolCall> {
    while (this.#pending.length === 0)
      await new Promise<void>((resolve) => this.#arrivals.push(resolve));
    const call = this.#pending.shift();
    if (call === undefined) throw new Error("no pending tool call");
    return call;
  }
}

export function testToolsExtension(port: FakeToolPort): Extension {
  return defineExtension({
    name: "test-tools",
    tools: [
      defineTool({
        name: "run_action",
        description: "Run a side-effectful action.",
        parameters: Type.Object({ input: Type.String() }),
        replay: "unsafe",
        execute: (args, _api, context) => port.run("run_action", args, context.abortSignal),
      }),
      defineTool({
        name: "read_item",
        description: "Read a replay-safe item.",
        parameters: Type.Object({ key: Type.String() }),
        replay: "safe",
        execute: (args, _api, context) => port.run("read_item", args, context.abortSignal),
      }),
    ],
  });
}

export type TestAgent = {
  readonly file: string;
  readonly provider: ScriptedProvider;
  readonly tools: FakeToolPort;
  open(options?: {
    onFatal?: (error: unknown) => void;
    onReport?: (error: unknown) => void;
    extensions?: readonly Extension[];
    background?: readonly RuntimeBackgroundTask[];
    credentials?: CredentialsLookup;
  }): Promise<{ runtime: AgentRuntime; database: () => FaultyDatabase }>;
};

export async function testAgent(
  settings: AgentSettings = defaultSettings,
  options: {
    clock?: Clock;
    provider?: ScriptedProvider;
    contextWindow?: number;
    init?: (tx: Tx) => void | Promise<void>;
  } = {},
): Promise<TestAgent> {
  const { clock, contextWindow, init } = options;
  const file = join(temporaryDirectory(), "agents", "agent-1.sqlite");
  const provider = options.provider ?? (await ScriptedProvider.start());
  if (options.provider === undefined) onTestFinished(() => provider.close());
  const tools = new FakeToolPort();
  const catalog = builtinModels();
  await createAgentStore(file, {
    settings,
    ...(init === undefined ? {} : { init }),
  });
  return {
    file,
    provider,
    tools,
    async open(openOptions = {}) {
      let database: FaultyDatabase | undefined;
      const runtime = await openAgentRuntime({
        file,
        credentials: openOptions.credentials ?? (() => ({ apiKey: "test-key" })),
        extensions: openOptions.extensions ?? [testToolsExtension(tools)],
        ...(openOptions.background === undefined ? {} : { background: openOptions.background }),
        resolveModel: ({ provider: name, modelId }) => {
          const model = catalog.getModel(name, modelId);
          return model === undefined
            ? undefined
            : {
                ...model,
                baseUrl: provider.baseUrl,
                ...(contextWindow === undefined ? {} : { contextWindow }),
              };
        },
        wrapDatabase: (inner) => (database = new FaultyDatabase(inner)),
        ...(clock === undefined ? {} : { clock }),
        ...(openOptions.onFatal === undefined ? {} : { onFatal: openOptions.onFatal }),
        ...(openOptions.onReport === undefined ? {} : { onReport: openOptions.onReport }),
      });
      onTestFinished(() => (database?.frozen ? undefined : runtime.close()));
      return {
        runtime,
        database: () => {
          if (database === undefined) throw new Error("runtime opened without a database");
          return database;
        },
      };
    },
  };
}

/** `promise`, or a rejection naming `what` if it has not settled within `ms`: a hang fails fast and says where. */
export async function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
