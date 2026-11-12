import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  Harness,
  createRegistry,
  watchEvents,
  type AgentEvent,
  type CompactionPolicy,
  type Conversation,
  type Cursor,
  defineDoc,
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { AgentStateDoc, type AgentUsage } from "./agent-state.ts";
import { AssistantsDoc, IDENTITY_SECTION, assistants, reconcileAssistants } from "./assistants.ts";
import type { InputKind, Plugin, PluginInput } from "@palace/agent-plugin";
import { systemClock, type Clock } from "@palace/clock";
import { DOCS_EXTENSION, docsExtension } from "./docs.ts";
import { historyExtension } from "./history.ts";
import { idleCompaction } from "./idle-compaction.ts";
import { Lifetime, guardDatabase } from "./lifetime.ts";
import { agentModels, type CredentialsLookup, type ModelResolver } from "./models.ts";
import { installPlugins, type Capability } from "./plugins.ts";
import { reminders } from "./reminders.ts";
import { agentChange, configureConversations, settingsOf, type AgentSettings } from "./settings.ts";
import { createAgentStorage, openAgentStorage, type DatabaseWrapper } from "./storage.ts";
import { workspaceExtension, type WorkspacePort } from "./workspace-tools.ts";

export type AgentRuntimeOptions = {
  /** `data/agents/<agentId>.sqlite`. Opening fails with `AgentStoreMissing` when it does not exist. */
  readonly file: string;
  /** Each provider's credentials, read at every model request, so a changed key applies from the next request. */
  readonly credentials: CredentialsLookup;
  readonly workspace: WorkspacePort;
  /**
   * The capabilities owned outside the runtime, installed after its own in this order. A primary plugin is absent from
   * assistants' conversations.
   */
  readonly plugins?: readonly Plugin[];
  readonly resolveModel?: ModelResolver;
  readonly wrapDatabase?: DatabaseWrapper;
  /** Called once if the runtime's storage fails. The runtime is then dead and the Agent should be reopened. */
  readonly onFatal?: (error: unknown) => void;
  /** Defaults to the system clock. Override in tests. */
  readonly clock?: Clock;
};

export type SubmittedInput = {
  /**
   * Resolves when the input was answered, or will never be (withdrawn, aborted, or its run failed). Rejects if this
   * runtime closes or its storage fails first: the input is then still stored, and its work resumes on reopen.
   */
  settled(): Promise<"done" | "unanswered">;
};

export type WithdrawResult = "withdrawn" | "already_placed" | "settled" | "not_found";

/** A watch on one conversation's agent events. */
export type EventWatch = {
  /** Stop delivering events. */
  stop(): Promise<void>;
  /** Resolves once no more events will come: after `stop()`, when the runtime closes, or when its storage fails. */
  readonly ended: Promise<void>;
};

/**
 * Create a new Agent store for an Agent whose workspace is on `nodeId`. The node is recorded in the same commit as the
 * settings and never changes. The Agent exists once this resolves.
 */
export async function createAgentStore(
  file: string,
  agent: { readonly nodeId: string; readonly settings: AgentSettings },
): Promise<void> {
  await createAgentStorage(file, async (storage) => {
    const lifetime = new Lifetime();
    const harness = await Harness.open(
      storage,
      {
        models: agentModels(() => undefined, undefined, lifetime.signal),
        registry: createRegistry(),
        settings: { toolExecution: "sequential" },
      },
      BACKGROUND_CONTEXT,
    );
    try {
      await harness.root(BACKGROUND_CONTEXT, {
        agent: agentChange(agent.settings),
        init: async (tx) => {
          (await tx.doc(AgentStateDoc)).nodeId = agent.nodeId;
        },
      });
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
}

/** Open an existing Agent's runtime and resume whatever its last process left unfinished. */
export async function openAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime> {
  const lifetime = new Lifetime();
  const clock = options.clock ?? systemClock;
  const registry = createRegistry();
  const primaryOnly = () =>
    capabilities.filter(({ scope }) => scope === "primary").map(({ extension }) => extension);
  const { primary: assistantsPrimary, identity: assistantsIdentity } = assistants(primaryOnly);
  const { extension: remindersExtension, run: runReminders } = reminders(clock, lifetime.signal);
  const models = agentModels(options.credentials, options.resolveModel, lifetime.signal);
  const { extension: idleExtension, run: runIdleCompaction } = idleCompaction(
    clock,
    lifetime,
    models,
    compaction,
  );
  // `harness` exists by the time a tool runs: no task is scheduled before `resume()`.
  const workspace = workspaceExtension(options.workspace, lifetime.signal, (id, context) =>
    harness.abortTask(id, context),
  );
  const installed = installPlugins(
    options.plugins ?? [],
    [
      workspace,
      historyExtension,
      assistantsPrimary,
      remindersExtension,
      idleExtension,
      assistantsIdentity,
    ]
      .map(({ name }) => name)
      // A plugin's name is also its section key, so it must not take the identity section's either.
      .concat(DOCS_EXTENSION, IDENTITY_SECTION),
  );
  const docs = docsExtension(installed.topics);
  // The install order is the order of the prompt's sections.
  const capabilities: readonly Capability[] = [
    { extension: workspace, scope: "every" },
    { extension: historyExtension, scope: "every" },
    ...(docs === undefined ? [] : [{ extension: docs, scope: "every" } as const]),
    { extension: assistantsPrimary, scope: "primary" },
    { extension: remindersExtension, scope: "primary" },
    { extension: idleExtension, scope: "primary" },
    ...installed.capabilities,
    { extension: assistantsIdentity, scope: "every" },
  ];
  const { storage, database } = await openAgentStorage(
    options.file,
    options.wrapDatabase,
    (opened) =>
      guardDatabase(opened, lifetime, (error) => {
        void database.close().catch(() => undefined);
        options.onFatal?.(error);
      }),
  );
  for (const { extension } of capabilities) registry.install(extension);
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: { toolExecution: "sequential", compaction },
    },
    BACKGROUND_CONTEXT,
  );
  let root: Conversation;
  try {
    root = await harness.root(BACKGROUND_CONTEXT);
    await reconcileAssistants(harness, root, primaryOnly());
  } catch (error) {
    lifetime.end();
    await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
    throw error;
  }
  const runtime = new AgentRuntime(harness, storage, root, lifetime, installed.kinds);
  harness.resume();
  // Run the reminder and idle compaction loops in the background; they exit when the lifetime ends.
  void runReminders(harness, root);
  void runIdleCompaction(root, (requestId) =>
    storage.submissionByRequest(root.id, requestId, BACKGROUND_CONTEXT),
  );
  return runtime;
}

export class AgentRuntime {
  readonly #harness: Harness;
  readonly #storage: SqliteStorage;
  readonly #root: Conversation;
  readonly #lifetime: Lifetime;
  readonly #kinds: ReadonlySet<InputKind<never>>;
  #closed: Promise<void> | undefined;

  constructor(
    harness: Harness,
    storage: SqliteStorage,
    root: Conversation,
    lifetime: Lifetime,
    kinds: ReadonlySet<InputKind<never>>,
  ) {
    this.#harness = harness;
    this.#storage = storage;
    this.#root = root;
    this.#lifetime = lifetime;
    this.#kinds = kinds;
  }

  /**
   * Admit an input to the primary conversation under its `requestId`, once however often it is sent, with its kind's
   * `whenBusy`. When the kind `replacesQueued`, every input of the kind still queued, other than this one, is withdrawn
   * first; one the model was handed meanwhile stays, so the model then sees both. Rejects, and admits nothing, when
   * the input's kind is not installed in this runtime.
   */
  async submit(input: PluginInput): Promise<SubmittedInput> {
    const { kind, requestId } = input;
    if (!this.#kinds.has(kind))
      throw new Error(`input kind ${kind.name} is not installed in this Agent`);
    if (kind.replacesQueued) await this.#withdrawQueued(`${kind.name}:`, requestId);
    const submission = await this.#root.submit(
      { type: "input", content: input.content, requestId, whenBusy: kind.whenBusy },
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
    await this.#root.commit((tx) => configureConversations(tx, settings), BACKGROUND_CONTEXT);
  }

  /** The model settings the Agent's conversations share. */
  async settings(): Promise<AgentSettings> {
    return settingsOf(await this.#harness.snapshot(AgentDoc, this.#root.id, BACKGROUND_CONTEXT));
  }

  /** Resolves when no work is running or queued. Rejects once the runtime is closed or dead. */
  idle(): Promise<void> {
    return this.#lifetime.orFailure(this.#harness.waitForIdle(BACKGROUND_CONTEXT));
  }

  async usage(): Promise<AgentUsage> {
    return this.#harness.usage(BACKGROUND_CONTEXT);
  }

  /** The names of the Agent's work assistants, whose conversations `watchEvents` can watch too. */
  async assistants(): Promise<string[]> {
    const state = await this.#harness.snapshot(AssistantsDoc, this.#root.id, BACKGROUND_CONTEXT);
    return Object.keys(state?.assistants ?? {}).sort();
  }

  /**
   * Watch the primary conversation's agent events, or with `assistant` that assistant's: streamed text, tool calls and
   * their output, inputs, usage. The first batch is a snapshot of the conversation as it is; a listener that falls far
   * behind gets a fresh snapshot instead of the batches it missed. Watching writes nothing. The watch ends when it is
   * stopped, the runtime closes, or the runtime dies from a storage failure; a runtime that has already died refuses
   * the watch.
   */
  async watchEvents(
    listener: (events: readonly AgentEvent[]) => void | Promise<void>,
    options: { assistant?: string } = {},
  ): Promise<EventWatch> {
    const { assistant } = options;
    let conversationId = this.#root.id;
    if (assistant !== undefined) {
      const state = await this.#harness.snapshot(AssistantsDoc, this.#root.id, BACKGROUND_CONTEXT);
      const found = state?.assistants[assistant];
      if (found === undefined) throw new Error(`no assistant named ${assistant}`);
      conversationId = found.conversationId;
    }
    const stream = await watchEvents(this.#harness, conversationId, BACKGROUND_CONTEXT);
    try {
      await listener([stream.snapshot]);
    } catch (error) {
      await stream.stop();
      throw error;
    }
    stream.start(async (events) => listener(events));
    // A dead runtime's stream never closes by itself, so a storage failure ends the watch here.
    const ended = Promise.race([stream.closed, this.#lifetime.failed]).then(() => undefined);
    return {
      stop: async () => {
        await Promise.race([stream.stop(), ended]);
      },
      ended,
    };
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

/**
 * Durable's own defaults today, stated here so that the thresholds packages/runtime/ARCHITECTURE.md documents cannot move with a
 * Durable release.
 */
const compaction: CompactionPolicy = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  backgroundTokens: 32_768,
};

/** Positions of the Agent's environment in its sources, such as the connector's in the chat inbox, by name. */
const CursorsDoc = defineDoc<{ positions: Record<string, number> }>({
  kind: "mate.cursors",
  version: 1,
  scope: "session",
  initial: () => ({ positions: {} }),
});
