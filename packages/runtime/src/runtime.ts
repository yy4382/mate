import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  Harness,
  createRegistry,
  watchEvents,
  type AgentEvent,
  type CompactionPolicy,
  type Conversation,
  type ConversationDocFamilyToken,
  type ConversationDocToken,
  type ConversationId,
  type Cursor,
  type Extension,
  type JsonObject,
  type SessionDocFamilyToken,
  type SessionDocToken,
  type Tx,
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { systemClock, type Clock } from "@palace/clock";
import type { AgentUsage } from "./agent-state.ts";
import { Lifetime, guardDatabase } from "./lifetime.ts";
import { agentModels, type CredentialsLookup, type ModelResolver } from "./models.ts";
import { agentChange, configureConversations, settingsOf, type AgentSettings } from "./settings.ts";
import { createAgentStorage, openAgentStorage, type DatabaseWrapper } from "./storage.ts";

export type RuntimeLifetime = {
  readonly signal: AbortSignal;
  orFailure<T>(work: Promise<T>): Promise<T>;
};

export type RuntimeBackgroundContext = {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly models: Models;
  readonly compaction: CompactionPolicy;
  readonly lifetime: RuntimeLifetime;
  readonly clock: Clock;
};

export type RuntimeBackgroundTask = (ctx: RuntimeBackgroundContext) => Promise<void>;

export type AgentRuntimeOptions = {
  /** `data/agents/<agentId>.sqlite`. Opening fails with `AgentStoreMissing` when it does not exist. */
  readonly file: string;
  /** Each provider's credentials, read at every model request, so a changed key applies from the next request. */
  readonly credentials: CredentialsLookup;
  /**
   * Native `pi-durable` extensions installed into the registry and offered to the primary conversation via
   * `settings.extensions`. Duplicate extension names fail opening.
   */
  readonly extensions?: readonly Extension[];
  /** Background loops started after `harness.resume()`, exiting when `ctx.lifetime.signal` aborts. */
  readonly background?: readonly RuntimeBackgroundTask[];
  readonly resolveModel?: ModelResolver;
  readonly wrapDatabase?: DatabaseWrapper;
  /** Called once if the runtime's storage fails. The runtime is then dead and the Agent should be reopened. */
  readonly onFatal?: (error: unknown) => void;
  /** Receives non-fatal extension or background failures. */
  readonly onReport?: (error: unknown) => void;
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

/** A watch on one conversation's agent events. */
export type EventWatch = {
  /** Stop delivering events. */
  stop(): Promise<void>;
  /** Resolves once no more events will come: after `stop()`, when the runtime closes, or when its storage fails. */
  readonly ended: Promise<void>;
};

/**
 * Create a new Agent store. The settings and optional initial documents are written in the root creation commit.
 * The Agent exists once this resolves.
 */
export async function createAgentStore(
  file: string,
  options: { readonly settings: AgentSettings; readonly init?: (tx: Tx) => void | Promise<void> },
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
        agent: agentChange(options.settings),
        ...(options.init === undefined ? {} : { init: options.init }),
      });
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
    }
  });
}

/** Open an existing Agent's runtime and resume whatever its last process left unfinished. */
export async function openAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntime> {
  const extensions = [...(options.extensions ?? [])];
  const names = new Set<string>();
  for (const extension of extensions) {
    if (names.has(extension.name)) throw new Error(`duplicate extension name: ${extension.name}`);
    names.add(extension.name);
  }
  const lifetime = new Lifetime();
  const clock = options.clock ?? systemClock;
  const registry = createRegistry();
  for (const extension of extensions) registry.install(extension);
  const models = agentModels(options.credentials, options.resolveModel, lifetime.signal);
  const { storage, database } = await openAgentStorage(
    options.file,
    options.wrapDatabase,
    (opened) =>
      guardDatabase(opened, lifetime, (error) => {
        void database.close().catch(() => undefined);
        options.onFatal?.(error);
      }),
  );
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      now: () => clock.now(),
      settings: { extensions, toolExecution: "sequential", compaction },
      ...(options.onReport === undefined ? {} : { onReport: options.onReport }),
    },
    BACKGROUND_CONTEXT,
  );
  let root: Conversation;
  try {
    root = await harness.root(BACKGROUND_CONTEXT);
  } catch (error) {
    lifetime.end();
    await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
    throw error;
  }
  const runtime = new AgentRuntime(harness, storage, root, lifetime);
  harness.resume();
  const backgroundContext: RuntimeBackgroundContext = {
    harness,
    root,
    models,
    compaction,
    lifetime,
    clock,
  };
  for (const run of options.background ?? []) {
    void run(backgroundContext).catch((error) => {
      if (!lifetime.signal.aborted) options.onReport?.(error);
    });
  }
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

  get rootConversationId(): ConversationId {
    return this.#root.id;
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

  /** Read a committed Durable document snapshot on this runtime's store. */
  snapshot<T extends JsonObject>(token: SessionDocToken<T>): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject>(
    token: ConversationDocToken<T>,
    conversationId: ConversationId,
  ): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject, I extends JsonValue>(
    token: SessionDocFamilyToken<T, I>,
    key: string,
  ): Promise<Readonly<T> | undefined>;
  snapshot<T extends JsonObject, I extends JsonValue>(
    token: ConversationDocFamilyToken<T, I>,
    conversationId: ConversationId,
    key: string,
  ): Promise<Readonly<T> | undefined>;
  snapshot(
    token:
      | SessionDocToken<JsonObject>
      | ConversationDocToken<JsonObject>
      | SessionDocFamilyToken<JsonObject, JsonValue>
      | ConversationDocFamilyToken<JsonObject, JsonValue>,
    arg1?: ConversationId | string,
    arg2?: string,
  ): Promise<Readonly<JsonObject> | undefined> {
    if (this.#lifetime.failure !== undefined) return Promise.reject(this.#lifetime.failure.error);
    if (arg1 === undefined) {
      return this.#lifetime.orFailure(
        this.#harness.snapshot(token as SessionDocToken<JsonObject>, BACKGROUND_CONTEXT),
      );
    }
    if (arg2 !== undefined) {
      return this.#lifetime.orFailure(
        this.#harness.snapshot(
          token as ConversationDocFamilyToken<JsonObject, JsonValue>,
          arg1 as ConversationId,
          arg2,
          BACKGROUND_CONTEXT,
        ),
      );
    }
    if (typeof arg1 === "string") {
      return this.#lifetime.orFailure(
        this.#harness.snapshot(
          token as SessionDocFamilyToken<JsonObject, JsonValue>,
          arg1,
          BACKGROUND_CONTEXT,
        ),
      );
    }
    return this.#lifetime.orFailure(
      this.#harness.snapshot(token as ConversationDocToken<JsonObject>, arg1, BACKGROUND_CONTEXT),
    );
  }

  /** Run an atomic transaction on this runtime's Durable session. */
  commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T> {
    if (this.#lifetime.failure !== undefined) return Promise.reject(this.#lifetime.failure.error);
    return this.#lifetime.orFailure(this.#harness.commit(change, BACKGROUND_CONTEXT));
  }

  /** Change the model settings of every conversation of this Agent, effective from each one's next request. */
  async configure(settings: AgentSettings): Promise<void> {
    await this.#lifetime.orFailure(
      this.#root.commit((tx) => configureConversations(tx, settings), BACKGROUND_CONTEXT),
    );
  }

  /** The model settings the Agent's conversations share. */
  async settings(): Promise<AgentSettings> {
    return settingsOf(
      await this.#lifetime.orFailure(
        this.#harness.snapshot(AgentDoc, this.#root.id, BACKGROUND_CONTEXT),
      ),
    );
  }

  /** Resolves when no work is running or queued. Rejects once the runtime is closed or dead. */
  idle(): Promise<void> {
    return this.#lifetime.orFailure(this.#harness.waitForIdle(BACKGROUND_CONTEXT));
  }

  async usage(): Promise<AgentUsage> {
    return this.#lifetime.orFailure(this.#harness.usage(BACKGROUND_CONTEXT));
  }

  /**
   * Watch the primary conversation's agent events, or with `conversationId` that conversation's: streamed text, tool
   * calls and their output, inputs, usage. The first batch is a snapshot of the conversation as it is; a listener that
   * falls far behind gets a fresh snapshot instead of the batches it missed. Watching writes nothing. The watch ends
   * when it is stopped, the runtime closes, or the runtime dies from a storage failure; a runtime that has already
   * died refuses the watch.
   */
  async watchEvents(
    listener: (events: readonly AgentEvent[]) => void | Promise<void>,
    options: { conversationId?: ConversationId } = {},
  ): Promise<EventWatch> {
    if (this.#lifetime.failure !== undefined) throw this.#lifetime.failure.error;
    const conversationId = options.conversationId ?? this.#root.id;
    if (options.conversationId !== undefined) {
      const found = await this.#lifetime.orFailure(
        this.#harness.conversation(conversationId, BACKGROUND_CONTEXT),
      );
      if (found === undefined) throw new Error(`no conversation ${conversationId}`);
    }
    const stream = await this.#lifetime.orFailure(
      watchEvents(this.#harness, conversationId, BACKGROUND_CONTEXT),
    );
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
 * Durable's own defaults today, stated here so that the thresholds packages/runtime/ARCHITECTURE.md documents cannot
 * move with a Durable release.
 */
const compaction: CompactionPolicy = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  backgroundTokens: 32_768,
};
