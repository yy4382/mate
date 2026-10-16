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
