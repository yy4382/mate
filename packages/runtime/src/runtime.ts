import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  Harness,
  configure,
  createRegistry,
  type Conversation,
  type Cursor,
  defineDoc,
  type Extension,
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { assistants } from "./assistants.ts";
import { chatExtension, type ChatPort } from "./chat-tools.ts";
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
  /** The chat app bound to this Agent's account. Without it the Agent has no chat tools. */
  readonly chat?: ChatPort;
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
  /**
   * Resolves when the input was answered, or will never be (withdrawn, aborted, or its run failed). Rejects if this
   * runtime closes or its storage fails first: the input is then still stored, and its work resumes on reopen.
   */
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
  const primaryOnlyExtensions: readonly Extension[] = [
    assistantsPrimary,
    remindersExtension,
    ...(options.chat === undefined ? [] : [chatExtension(options.chat)]),
  ];
  registry.install(workspaceExtension(options.workspace, lifetime.signal));
  for (const extension of primaryOnlyExtensions) registry.install(extension);
  registry.install(assistantsIdentity);
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

  /**
   * Admit an input to the primary conversation. The same `requestId` is admitted once, however often it is sent.
   * With `replaces`, every input still queued whose requestId starts with it, other than `requestId` itself, is
   * withdrawn first; one the model was handed meanwhile stays, so the model then sees both.
   */
  async submit(
    content: string,
    options: { requestId: string; whenBusy?: WhenBusy; replaces?: string },
  ): Promise<SubmittedInput> {
    if (options.replaces !== undefined)
      await this.#withdrawQueued(options.replaces, options.requestId);
    const submission = await this.#root.submit(
      {
        type: "input",
        content,
        requestId: options.requestId,
        whenBusy: options.whenBusy ?? "followUp",
      },
      BACKGROUND_CONTEXT,
    );
    return {
      settled: async () =>
        (await this.#lifetime.orFailure(submission.wait(BACKGROUND_CONTEXT))).status,
    };
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

  /** Withdraw the queued inputs whose requestId starts with `prefix`, except `keep`. Queued is what Durable stores. */
  async #withdrawQueued(prefix: string, keep: string): Promise<void> {
    let cursor: Cursor | undefined;
    do {
      const page = await this.#storage.scanSubmissions(
        { conversationId: this.#root.id, status: "queued" },
        100,
        cursor,
        BACKGROUND_CONTEXT,
      );
      for (const record of page.items) {
        if (record.requestId === undefined || record.requestId === keep) continue;
        if (!record.requestId.startsWith(prefix)) continue;
        // A boundary may place it in the meantime; Durable then reports it placed and leaves it to the model.
        await this.#harness.abortSubmission(record.id, BACKGROUND_CONTEXT, this.#root.id);
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }

  /** The position stored under `name`, 0 until first advanced. */
  async cursor(name: string): Promise<number> {
    return (await this.#harness.snapshot(CursorsDoc, BACKGROUND_CONTEXT))?.positions[name] ?? 0;
  }

  /** Move the position stored under `name` forward to `value`. A position never moves back. */
  async advanceCursor(name: string, value: number): Promise<void> {
    await this.#harness.commit(async (tx) => {
      const state = await tx.doc(CursorsDoc);
      if ((state.positions[name] ?? 0) < value) state.positions[name] = value;
    }, BACKGROUND_CONTEXT);
  }

  /** Change the model settings of every conversation of this Agent, effective from each one's next request. */
  async configure(settings: AgentSettings): Promise<void> {
    await this.#root.commit(async (tx) => {
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanConversations({}, 100, cursor);
        for (const conversation of page.items)
          await configure(tx, conversation.id, agentChange(settings));
        cursor = page.next;
      } while (cursor !== undefined);
    }, BACKGROUND_CONTEXT);
  }

  /** Resolves when no work is running or queued. Rejects once the runtime is closed or dead. */
  idle(): Promise<void> {
    return this.#lifetime.orFailure(this.#harness.waitForIdle(BACKGROUND_CONTEXT));
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

/** Positions of the Agent's environment in its sources, such as the connector's in the chat inbox, by name. */
const CursorsDoc = defineDoc<{ positions: Record<string, number> }>({
  kind: "mate.cursors",
  version: 1,
  scope: "session",
  initial: () => ({ positions: {} }),
});

function agentChange(settings: AgentSettings) {
  return {
    model: settings.model,
    thinkingLevel: settings.thinkingLevel ?? null,
    instructions: settings.instructions ?? null,
  };
}
