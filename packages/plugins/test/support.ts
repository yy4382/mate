import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Extension } from "@earendil-works/pi-durable";
import {
  createAgentStore,
  openAgentRuntime,
  type AgentRuntime,
  type AgentSettings,
  type Clock,
  type RuntimeBackgroundTask,
} from "@palace/runtime";
import { FaultyDatabase, ScriptedProvider, temporaryDirectory } from "@palace/testkit";
import { join } from "node:path";
import { onTestFinished } from "vitest";

export { FakeClock } from "@palace/testkit";

export const defaultSettings: AgentSettings = { model: { provider: "openai", modelId: "gpt-4.1" } };

export type PluginTestAgent = {
  readonly file: string;
  readonly provider: ScriptedProvider;
  open(options?: {
    extensions?: readonly Extension[];
    background?: readonly RuntimeBackgroundTask[];
    onReport?: (error: unknown) => void;
    onFatal?: (error: unknown) => void;
  }): Promise<{ runtime: AgentRuntime; database: () => FaultyDatabase }>;
};

export async function testAgent(
  settings: AgentSettings = defaultSettings,
  options: {
    readonly clock?: Clock;
    readonly contextWindow?: number;
    readonly defaultExtensions?: () => readonly Extension[];
    readonly defaultBackground?: () => readonly RuntimeBackgroundTask[];
  } = {},
): Promise<PluginTestAgent> {
  const file = join(temporaryDirectory(), "agents", "agent-1.sqlite");
  const provider = await ScriptedProvider.start();
  onTestFinished(() => provider.close());
  const catalog = builtinModels();
  await createAgentStore(file, { settings });
  return {
    file,
    provider,
    async open(openOptions = {}) {
      let database: FaultyDatabase | undefined;
      const runtime = await openAgentRuntime({
        file,
        credentials: () => ({ apiKey: "test-key" }),
        extensions: openOptions.extensions ?? options.defaultExtensions?.() ?? [],
        background: openOptions.background ?? options.defaultBackground?.() ?? [],
        resolveModel: ({ provider: name, modelId }) => {
          const model = catalog.getModel(name, modelId);
          return model === undefined
            ? undefined
            : {
                ...model,
                baseUrl: provider.baseUrl,
                ...(options.contextWindow === undefined
                  ? {}
                  : { contextWindow: options.contextWindow }),
              };
        },
        wrapDatabase: (inner) => (database = new FaultyDatabase(inner)),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(openOptions.onReport === undefined ? {} : { onReport: openOptions.onReport }),
        ...(openOptions.onFatal === undefined ? {} : { onFatal: openOptions.onFatal }),
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
