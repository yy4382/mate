import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { FakeWorkspace, FaultyDatabase, ScriptedProvider, temporaryDirectory } from "@mate/testkit";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import {
  createAgentStore,
  openAgentRuntime,
  type AgentRuntime,
  type AgentSettings,
  type ChatPort,
  type Clock,
} from "../src/index.ts";

export { FakeClock, FakeWorkspace, toolText as text } from "@mate/testkit";

export const defaultSettings: AgentSettings = { model: { provider: "openai", modelId: "gpt-4.1" } };

export type TestAgent = {
  readonly file: string;
  readonly provider: ScriptedProvider;
  readonly workspace: FakeWorkspace;
  open(options?: {
    onFatal?: (error: unknown) => void;
    chat?: ChatPort;
    /** Read at every model request; defaults to a fixed key. */
    apiKey?: () => string;
  }): Promise<{ runtime: AgentRuntime; database: () => FaultyDatabase }>;
};

/**
 * A created Agent store, a scripted provider, and a fake workspace, all cleaned up after the test. Pass `provider` to
 * let several Agents share one provider, each conversation on its own lane, and `contextWindow` to give every model
 * that many tokens of context instead of its catalog size.
 */
export async function testAgent(
  settings: AgentSettings = defaultSettings,
  options: { clock?: Clock; provider?: ScriptedProvider; contextWindow?: number } = {},
): Promise<TestAgent> {
  const { clock, contextWindow } = options;
  const file = join(temporaryDirectory(), "agents", "agent-1.sqlite");
  const provider = options.provider ?? (await ScriptedProvider.start());
  if (options.provider === undefined) onTestFinished(() => provider.close());
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
        apiKey: options.apiKey ?? (() => "test-key"),
        workspace,
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
