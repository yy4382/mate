import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ChatApp } from "@mate/chat";
import { systemClock, type Clock } from "@mate/clock";
import {
  configureAgentFile,
  createAgentStore,
  openAgentRuntime,
  readAgentState,
  setAgentPaused,
  type AgentRuntime,
  type AgentSettings,
  type AgentState as AgentFileState,
  type AgentUsage,
  type CredentialsLookup,
  type WorkspacePort,
} from "@mate/runtime";
import { AgentFiles } from "./agent-files.ts";
import { connectInbox, type InboxConnector } from "./connector.ts";

/**
 * Where Agents' workspaces live: on nodes. Preparing is idempotent: it creates the Agent's workspace on the node once,
 * later calls do nothing. The port runs the Agent's workspace tools on that node.
 */
export type WorkspaceHost = {
  prepare(nodeId: string, agentId: string): Promise<void>;
  port(nodeId: string, agentId: string): WorkspacePort;
};

export type AgentManagerOptions = {
  /** `data/agents/`. Created if missing. */
  readonly directory: string;
  readonly chat: ChatApp;
  readonly workspaces: WorkspaceHost;
  /** Each provider's credentials, read at every model request of every Agent. */
  readonly credentials: CredentialsLookup;
  readonly clock?: Clock;
  /** Told about an Agent that failed to open, a failed connector pass, or a runtime whose storage failed. */
  readonly report?: (error: unknown, agentId: string) => void;
};

export type AgentSpec = {
  /** Pass the ID of a failed create to finish that Agent instead of starting another. */
  readonly agentId?: string;
  /** The node the Agent's workspace is on. It is recorded in the Agent's file and never changes. */
  readonly nodeId: string;
  readonly displayName: string;
  readonly handle: string;
  readonly settings: AgentSettings;
};

export type AgentSummary = { readonly agentId: string; readonly open: boolean };

/**
 * An Agent as it is now. `paused` and `closed` are both closed Agents: a paused one stays closed until it is resumed; a
 * closed one failed to open or its runtime died, and opens again on resume or the next start.
 */
export type AgentDescription = {
  readonly agentId: string;
  readonly nodeId: string;
  readonly state: "open" | "paused" | "closed";
  readonly settings: AgentSettings;
  readonly usage: AgentUsage;
};

/** A create that stopped part way. Calling `create` again with `agentId` finishes the same Agent. */
export class AgentCreationFailed extends Error {
  readonly agentId: string;

  constructor(agentId: string, cause: unknown) {
    super(`creating Agent ${agentId} failed; create it again with this agentId to finish`, {
      cause,
    });
    this.agentId = agentId;
  }
}

/** `create` was given the ID of an Agent that exists. Nothing was changed. */
export class AgentIdInUse extends Error {
  readonly agentId: string;

  constructor(agentId: string) {
    super(`Agent ${agentId} already exists`);
    this.agentId = agentId;
  }
}

/**
 * What the manager knows of an Agent: open, with its runtime and connector, or closed. An Agent missing from the map is
 * closed. Only a closed Agent reaches its file directly: its paused record, its node, its settings. Each of those reads
 * and writes opens its own Durable session on the file, so doing it while a runtime is open on that file would corrupt
 * the runtime's storage. Reaching the file through `Closed` makes that impossible; an open Agent is reached through
 * its runtime, and keeps the node it was opened on.
 */
type AgentState = Open | Closed;
type Open = {
  readonly kind: "open";
  readonly nodeId: string;
  readonly runtime: AgentRuntime;
  readonly inbox: InboxConnector;
};
type Closed = {
  readonly kind: "closed";
  readonly read: () => Promise<AgentFileState>;
  readonly setPaused: (paused: boolean) => Promise<void>;
  readonly configure: (settings: AgentSettings) => Promise<void>;
};

/** Open every Agent in the directory that is not paused. An Agent that fails to open is reported and skipped. */
export function openAgentManager(options: AgentManagerOptions): Promise<AgentManager> {
  return AgentManager.open(options);
}

/**
 * The only place runtimes are opened and closed. Every lifecycle operation on an Agent runs in that Agent's queue, one
 * after another, so an Agent never has two runtimes open. Its connector is attached when its runtime opens and
 * stopped before it closes. A runtime whose storage fails is closed and reported; the Agent stays closed, not paused,
 * until it is resumed or the manager next opens.
 */
export class AgentManager {
  readonly #files: AgentFiles;
  readonly #options: AgentManagerOptions;
  readonly #clock: Clock;
  readonly #open = new Map<string, Open>();
  /** The tail of each Agent's queue of lifecycle operations. It never rejects. */
  readonly #queues = new Map<string, Promise<void>>();
  #closed = false;

  private constructor(options: AgentManagerOptions) {
    this.#options = options;
    this.#files = new AgentFiles(options.directory);
    this.#clock = options.clock ?? systemClock;
  }

  static async open(options: AgentManagerOptions): Promise<AgentManager> {
    const manager = new AgentManager(options);
    await Promise.all(
      manager.#files.agentIds().map((agentId) =>
        manager
          .#lifecycle(agentId, async (state) => {
            if (state.kind === "closed") await manager.#start(agentId, state);
          })
          .catch((error: unknown) => manager.#report(error, agentId)),
      ),
    );
    return manager;
  }

  /** Every Agent, open or not. */
  list(): AgentSummary[] {
    return this.#files.agentIds().map((agentId) => ({ agentId, open: this.#open.has(agentId) }));
  }

  /** The Agent's runtime while it is open. */
  runtime(agentId: string): AgentRuntime | undefined {
    return this.#open.get(agentId)?.runtime;
  }

  /** The Agent's node, state, settings and usage. Rejects with `AgentStoreMissing` when the Agent does not exist. */
  describe(agentId: string): Promise<AgentDescription> {
    return this.#lifecycle(agentId, async (state) => {
      if (state.kind === "open") {
        const { nodeId, runtime } = state;
        const settings = await runtime.settings();
        return { agentId, nodeId, state: "open", settings, usage: await runtime.usage() };
      }
      const { paused, nodeId, settings, usage } = await state.read();
      return { agentId, nodeId, state: paused ? "paused" : "closed", settings, usage };
    });
  }

  /** Change the Agent's model settings, open or closed. An open Agent uses them from its next model request. */
  configure(agentId: string, settings: AgentSettings): Promise<void> {
    return this.#lifecycle(agentId, (state) =>
      state.kind === "open" ? state.runtime.configure(settings) : state.configure(settings),
    );
  }

  /**
   * Create an Agent and open it: its chat account, its workspace on the chosen node, then its store, which records the
   * node and is renamed into place last, so the Agent exists only once everything else is in place. Every step before
   * the rename can be repeated, so when one fails the caller creates again with the `agentId` of the
   * `AgentCreationFailed` and gets the same Agent, with one account and one file.
   *
   * An ID that already names an Agent, or named one that was deleted, is refused (`AgentIdInUse`, or `inactive-account`
   * from the chat app), as is anything the chat app refuses about the names: nothing exists yet, so these are not
   * `AgentCreationFailed`. Once the store is in place the Agent exists, so a runtime that then fails to open is reported
   * and leaves the Agent closed, as at startup; `resume` opens it.
   */
  create(spec: AgentSpec): Promise<string> {
    const agentId = spec.agentId ?? randomUUID();
    return this.#lifecycle(agentId, async (state, file) => {
      if (state.kind === "open" || existsSync(file)) throw new AgentIdInUse(agentId);
      const { chat, workspaces } = this.#options;
      chat.ensureAccount({
        externalId: agentId,
        displayName: spec.displayName,
        handle: spec.handle,
      });
      try {
        await workspaces.prepare(spec.nodeId, agentId);
        await createAgentStore(file, { nodeId: spec.nodeId, settings: spec.settings });
      } catch (error) {
        throw new AgentCreationFailed(agentId, error);
      }
      try {
        await this.#start(agentId, state);
      } catch (error) {
        this.#report(error, agentId);
      }
      return agentId;
    });
  }

  /** Close the Agent's runtime, aborting its model requests and tool calls, and record it as paused. */
  pause(agentId: string): Promise<void> {
    return this.#lifecycle(agentId, async (state) => {
      const closed = state.kind === "open" ? await this.#stop(agentId, state) : state;
      await closed.setPaused(true);
    });
  }

  /** Clear the pause and open the runtime; Durable continues where it stopped. An open Agent stays as it is. */
  resume(agentId: string): Promise<void> {
    return this.#lifecycle(agentId, async (state) => {
      if (state.kind === "open") return;
      await state.setPaused(false);
      await this.#start(agentId, state);
    });
  }

  /** Close the Agent, deactivate its chat account, and remove its file. Its messages stay readable. */
  delete(agentId: string): Promise<void> {
    return this.#lifecycle(agentId, async (state) => {
      if (state.kind === "open") await this.#stop(agentId, state);
      const { chat } = this.#options;
      const account = chat.findAccount(agentId);
      // Deactivate before removing, so a delete that dies in between leaves an Agent to delete again.
      if (account !== undefined)
        chat.deactivateAccount(account, { requestId: `delete:${agentId}` });
      this.#files.remove(agentId);
    });
  }

  /** Close every runtime. The manager accepts no further operations. */
  async close(): Promise<void> {
    this.#closed = true;
    const agentIds = new Set([...this.#open.keys(), ...this.#queues.keys()]);
    await Promise.all(
      [...agentIds].map((agentId) =>
        this.#serial(agentId, async () => {
          const state = this.#open.get(agentId);
          if (state !== undefined) await this.#stop(agentId, state);
        }),
      ),
    );
  }

  /** Run `work` in the Agent's queue with the Agent's state as it is when its turn comes. Rejects on a bad ID. */
  async #lifecycle<T>(
    agentId: string,
    work: (state: AgentState, file: string) => Promise<T>,
  ): Promise<T> {
    if (this.#closed) throw new Error("the Agent Manager is closed");
    const file = this.#files.file(agentId);
    return this.#serial(agentId, () => work(this.#open.get(agentId) ?? closed(file), file));
  }

  /** Run `work` after every operation already queued for the Agent has finished, whether it failed or not. */
  #serial<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const result = (this.#queues.get(agentId) ?? Promise.resolve()).then(work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(agentId, tail);
    void tail.then(() => {
      if (this.#queues.get(agentId) === tail) this.#queues.delete(agentId);
    });
    return result;
  }

  /** Open the closed Agent unless it is paused, with its workspace on the node its file records. Runs in its queue. */
  async #start(agentId: string, state: Closed): Promise<void> {
    const { paused, nodeId } = await state.read();
    if (paused) return;
    const file = this.#files.file(agentId);
    const { chat, workspaces, credentials } = this.#options;
    // The chat app holds the account; the Agent ID is its external identity, so there is no second record of it.
    const account = chat.findAccount(agentId);
    if (account === undefined) throw new Error(`Agent ${agentId} has no chat account`);
    const report = (error: unknown) => this.#report(error, agentId);
    let opened: Open | undefined;
    const runtime = await openAgentRuntime({
      file,
      credentials,
      workspace: workspaces.port(nodeId, agentId),
      chat: chat.forAccount(account),
      clock: this.#clock,
      onFatal: (error) => {
        report(error);
        // A dead runtime does nothing more; close it in its turn so the Agent is closed, not falsely open.
        void this.#serial(agentId, async () => {
          if (opened !== undefined && this.#open.get(agentId) === opened)
            await this.#stop(agentId, opened);
        });
      },
    });
    const inbox = await connectInbox({ chat, account, runtime, clock: this.#clock, report });
    opened = { kind: "open", nodeId, runtime, inbox };
    this.#open.set(agentId, opened);
  }

  /** Stop the connector, then close the runtime. Runs in the Agent's queue. */
  async #stop(agentId: string, state: Open): Promise<Closed> {
    this.#open.delete(agentId);
    await state.inbox.stop();
    await state.runtime.close();
    return closed(this.#files.file(agentId));
  }

  #report(error: unknown, agentId: string): void {
    (this.#options.report ?? defaultReport)(error, agentId);
  }
}

function closed(file: string): Closed {
  return {
    kind: "closed",
    read: () => readAgentState(file),
    setPaused: (paused) => setAgentPaused(file, paused),
    configure: (settings) => configureAgentFile(file, settings),
  };
}

function defaultReport(error: unknown, agentId: string): void {
  console.error(`Agent ${agentId}:`, error);
}
