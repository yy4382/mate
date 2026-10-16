import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  Harness,
  configure,
  createRegistry,
  type Conversation,
  type Extension,
  type HarnessOptions,
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { assistants } from "./assistants.ts";
import { systemClock, type Clock } from "@mate/clock";
import { Lifetime, guardDatabase } from "./lifetime.ts";
import { agentModels, type ModelRef, type ModelResolver } from "./models.ts";
import { reminders } from "./reminders.ts";
import { createAgentStorage, openAgentStorage, type DatabaseWrapper } from "./storage.ts";
import { workspaceExtension, type WorkspacePort } from "./workspace-tools.ts";

export type AgentSettings = {
  readonly model: ModelRef;
  readonly thinkingLevel?: ModelThinkingLevel;
  readonly instructions?: string;
};

export type AgentRuntimeOptions = {
  /** `data/agents/<agentId>.sqlite`. Opening fails with `AgentStoreMissing` when it does not exist. */
  readonly file: string;
  /** Read at every model request, so a key change applies from the next request. */
  readonly apiKey: () => string;
  readonly workspace: WorkspacePort;
  readonly resolveModel?: ModelResolver;
  readonly wrapDatabase?: DatabaseWrapper;
  /** Called once if the runtime's storage fails. The runtime is then dead and the Agent should be reopened. */
  readonly onFatal?: (error: unknown) => void;
  /** Defaults to the system clock. Override in tests. */
  readonly clock?: Clock;
};

/** When an input arrives while the Agent is working: join the current work after this tool round, or wait for it. */
export type WhenBusy = "steer" | "followUp";

export type SubmittedInput = {
  /** Resolves when the input was answered, or will never be (withdrawn, aborted, or failed). */
  settled(): Promise<"done" | "unanswered">;
};

export type WithdrawResult = "withdrawn" | "already_placed" | "settled" | "not_found";

/** Create a new Agent store. The Agent exists once this resolves. */
export async function createAgentStore(file: string, settings: AgentSettings): Promise<void> {
  await createAgentStorage(file, async (storage) => {
    const lifetime = new Lifetime();
    const harness = await Harness.open(
      storage,
      {
        models: agentModels(() => "", undefined, lifetime.signal),
        registry: createRegistry(),
        settings: { toolExecution: "sequential" },
      },
      BACKGROUND_CONTEXT,
    );
    try {
      await harness.root(BACKGROUND_CONTEXT, { agent: agentChange(settings) });
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
}

/** Open an existing Agent's runtime and resume whatever its last process left unfinished. */
export async function openAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime> {
  const lifetime = new Lifetime();
  const { storage, database } = await openAgentStorage(
    options.file,
    options.wrapDatabase,
    (opened) =>
      guardDatabase(opened, lifetime, (error) => {
        void database.close().catch(() => undefined);
        options.onFatal?.(error);
      }),
  );
  const clock = options.clock ?? systemClock;
  const registry = createRegistry();
  const { primary: assistantsPrimary, identity: assistantsIdentity } = assistants(
    () => primaryOnlyExtensions,
  );
  const { extension: remindersExtension, run: runReminders } = reminders(clock, lifetime.signal);
  // Extensions available in the primary conversation only; assistants must not have them.
  const primaryOnlyExtensions: readonly Extension[] = [assistantsPrimary, remindersExtension];
  if (options.workspace !== undefined) {
    registry.install(workspaceExtension(options.workspace, lifetime.signal));
  }
  registry.install(assistantsPrimary);
  registry.install(assistantsIdentity);
  registry.install(remindersExtension);
  const harness = await Harness.open(
    storage,
    {
      models: agentModels(options.apiKey, options.resolveModel, lifetime.signal),
      registry,
      settings: { toolExecution: "sequential" },
    },
    BACKGROUND_CONTEXT,
  );
  const root = await harness.root(BACKGROUND_CONTEXT);
  const runtime = new AgentRuntime(harness, storage, root, lifetime);
  harness.resume();
  // Run the reminder loop in the background; it exits when the lifetime ends.
  void runReminders(harness, root);
  return runtime;
}

export class AgentRuntime {
  readonly #harness: Harness;
  readonly #storage: SqliteStorage;
  readonly #root: Conversation;
  readonly #lifetime: Lifetime;
  #closed: Promise<void> | undefined;

  constructor(harness: Harness, storage: SqliteStorage, root: Conversation, lifetime: Lifetime) {
    this.#harness = harness;
    this.#storage = storage;
    this.#root = root;
    this.#lifetime = lifetime;
  }

  /** Admit an input to the primary conversation. The same `requestId` is admitted once, however often it is sent. */
  async submit(
    content: string,
    options: { requestId: string; whenBusy?: WhenBusy },
  ): Promise<SubmittedInput> {
    const submission = await this.#root.submit(
      {
        type: "input",
        content,
        requestId: options.requestId,
        whenBusy: options.whenBusy ?? "followUp",
      },
      BACKGROUND_CONTEXT,
    );
    return { settled: async () => (await submission.wait(BACKGROUND_CONTEXT)).status };
  }

  /** Withdraw the input admitted under `requestId`, if the model has not seen it yet. */
  async withdraw(requestId: string): Promise<WithdrawResult> {
    const record = await this.#storage.submissionByRequest(
      this.#root.id,
      requestId,
      BACKGROUND_CONTEXT,
    );
    if (record === undefined) return "not_found";
    const result = await this.#harness.abortSubmission(
      record.id,
      BACKGROUND_CONTEXT,
      this.#root.id,
    );
    return result === "aborted" ? "withdrawn" : result;
  }

  /** Change the model settings of every conversation of this Agent, effective from each one's next request. */
  async configure(settings: AgentSettings): Promise<void> {
    await this.#root.commit(async (tx) => {
      const page = await tx.scanConversations({}, 1000);
      for (const conversation of page.items)
        await configure(tx, conversation.id, agentChange(settings));
    }, BACKGROUND_CONTEXT);
  }

  /** Resolves when no work is running or queued. */
  idle(): Promise<void> {
    return this.#harness.waitForIdle(BACKGROUND_CONTEXT);
  }

  async usage() {
    return this.#harness.usage(BACKGROUND_CONTEXT);
  }

  /**
   * Stop at once: open model requests and tool calls are aborted. Unfinished work resumes when the Agent is reopened.
   * A runtime whose storage failed is already dead; closing it only waits for nothing.
   */
  close(): Promise<void> {
    this.#closed ??= (async () => {
      this.#lifetime.end();
      if (this.#lifetime.failure !== undefined) return;
      await Promise.race([this.#harness.close(BACKGROUND_CONTEXT), this.#lifetime.failed]);
    })();
    return this.#closed;
  }
}

function agentChange(settings: AgentSettings) {
  return {
    model: settings.model,
    thinkingLevel: settings.thinkingLevel ?? null,
    instructions: settings.instructions ?? null,
  };
}
