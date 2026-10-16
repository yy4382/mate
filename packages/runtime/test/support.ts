import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { FakeClock, FaultyDatabase, ScriptedProvider, temporaryDirectory } from "@mate/testkit";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import {
  createAgentStore,
  openAgentRuntime,
  type AgentRuntime,
  type AgentSettings,
  type ChatPort,
  type Clock,
  type WorkspacePort,
  type WorkspaceToolRequest,
  type WorkspaceToolResult,
} from "../src/index.ts";

export { FakeClock } from "@mate/testkit";

export const defaultSettings: AgentSettings = { model: { provider: "openai", modelId: "gpt-4.1" } };

type PendingCall = {
  readonly request: WorkspaceToolRequest;
  readonly signal: AbortSignal;
  resolve(result: WorkspaceToolResult): void;
};

/** Stands in for the node gateway: records every forwarded call and lets the test answer it. */
export class FakeWorkspace implements WorkspacePort {
  readonly calls: WorkspaceToolRequest[] = [];
  readonly #pending: PendingCall[] = [];
  readonly #arrivals: (() => void)[] = [];
  #autoAnswer: ((request: WorkspaceToolRequest) => WorkspaceToolResult) | undefined;

  answerAll(answer: (request: WorkspaceToolRequest) => WorkspaceToolResult): void {
    this.#autoAnswer = answer;
  }

  run(
    request: WorkspaceToolRequest,
    _output: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<WorkspaceToolResult> {
    this.calls.push(request);
    for (const arrived of this.#arrivals.splice(0)) arrived();
    if (this.#autoAnswer !== undefined) return Promise.resolve(this.#autoAnswer(request));
    const { promise, resolve } = Promise.withResolvers<WorkspaceToolResult>();
    this.#pending.push({ request, signal, resolve });
    return promise;
  }

  /** Wait until a call is in flight and return it, unanswered. */
  async nextCall(): Promise<PendingCall> {
    while (this.#pending.length === 0)
      await new Promise<void>((resolve) => this.#arrivals.push(resolve));
    const call = this.#pending.shift();
    if (call === undefined) throw new Error("no pending workspace call");
    return call;
  }
}

export function text(value: string, isError = false): WorkspaceToolResult {
  return { content: [{ type: "text", text: value }], isError };
}

export type TestAgent = {
  readonly file: string;
  readonly provider: ScriptedProvider;
  readonly workspace: FakeWorkspace;
  open(options?: {
    onFatal?: (error: unknown) => void;
    chat?: ChatPort;
  }): Promise<{ runtime: AgentRuntime; database: () => FaultyDatabase }>;
};

/** A created Agent store, a scripted provider, and a fake workspace, all cleaned up after the test. */
export async function testAgent(
  settings: AgentSettings = defaultSettings,
  clock?: Clock,
): Promise<TestAgent> {
  const file = join(temporaryDirectory(), "agents", "agent-1.sqlite");
  const provider = await ScriptedProvider.start();
  onTestFinished(() => provider.close());
  const workspace = new FakeWorkspace();
  const catalog = builtinModels();
  await createAgentStore(file, settings);
  return {
    file,
    provider,
    workspace,
    async open(options = {}) {
      let database: FaultyDatabase | undefined;
      const runtime = await openAgentRuntime({
        file,
        apiKey: () => "test-key",
        workspace,
        resolveModel: ({ provider: name, modelId }) => {
          const model = catalog.getModel(name, modelId);
          return model === undefined ? undefined : { ...model, baseUrl: provider.baseUrl };
        },
        wrapDatabase: (inner) => (database = new FaultyDatabase(inner)),
        ...(clock === undefined ? {} : { clock }),
        ...(options.onFatal === undefined ? {} : { onFatal: options.onFatal }),
        ...(options.chat === undefined ? {} : { chat: options.chat }),
      });
      // A frozen store stands for a dead process: there is nothing left to close, and closing would wait forever.
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
