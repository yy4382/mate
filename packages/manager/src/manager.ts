import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ChatApp } from "@mate/chat";
import { systemClock, type Clock } from "@mate/clock";
import {
  createAgentStore,
  openAgentRuntime,
  readAgentState,
  setAgentPaused,
  type AgentRuntime,
  type AgentSettings,
  type ModelResolver,
  type WorkspacePort,
} from "@mate/runtime";
import { AgentFiles } from "./agent-files.ts";
import { chatPort } from "./chat-port.ts";
import { connectInbox, type InboxConnector } from "./connector.ts";

/** Where Agents' workspaces live. Preparing is idempotent: it creates the workspace once, later calls do nothing. */
export type WorkspaceHost = {
  prepare(agentId: string): Promise<void>;
  port(agentId: string): WorkspacePort;
};

export type AgentManagerOptions = {
  /** `data/agents/`. Created if missing. */
  readonly directory: string;
  readonly chat: ChatApp;
  readonly workspaces: WorkspaceHost;
  readonly apiKey: () => string;
  readonly resolveModel?: ModelResolver;
  readonly clock?: Clock;
  /** Told about an Agent that failed to open, a failed connector pass, or a runtime whose storage failed. */
  readonly report?: (error: unknown, agentId: string) => void;
};

export type AgentSpec = {
  /** Pass the ID of a failed create to finish that Agent instead of starting another. */
  readonly agentId?: string;
  readonly displayName: string;
  readonly handle: string;
  readonly settings: AgentSettings;
};

export type AgentSummary = { readonly agentId: string; readonly open: boolean };

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

type OpenAgent = { readonly runtime: AgentRuntime; readonly inbox: InboxConnector };

/** Open every Agent in the directory that is not paused. An Agent that fails to open is reported and skipped. */
export function openAgentManager(options: AgentManagerOptions): Promise<AgentManager> {
  return AgentManager.open(options);
}

/**
 * The only place runtimes are opened and closed. Every lifecycle operation on an Agent runs in that Agent's queue, one
 * after another, so an Agent never has two runtimes open. Its connector is attached when its runtime opens and
 * stopped before it closes.
 */
export class AgentManager {
  readonly #files: AgentFiles;
  readonly #options: AgentManagerOptions;
  readonly #clock: Clock;
  readonly #running = new Map<string, OpenAgent>();
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
      manager.#files
        .agentIds()
        .map((agentId) =>
          manager
            .#serial(agentId, () => manager.#start(agentId))
            .catch((error: unknown) => manager.#report(error, agentId)),
        ),
    );
    return manager;
  }

  /** Every Agent, open or not. */
  list(): AgentSummary[] {
    return this.#files.agentIds().map((agentId) => ({ agentId, open: this.#running.has(agentId) }));
  }

  /** The Agent's runtime while it is open. */
  runtime(agentId: string): AgentRuntime | undefined {
    return this.#running.get(agentId)?.runtime;
  }

  /**
   * Create an Agent and open it: its chat account, its workspace, then its store, which is renamed into place last, so
   * the Agent exists only once everything else is in place. Every step can be repeated, so when one fails the caller
   * creates again with the `agentId` of the `AgentCreationFailed` and gets the same Agent, with one account and one
   * file.
   */
  create(spec: AgentSpec): Promise<string> {
    const agentId = spec.agentId ?? randomUUID();
    const file = this.#files.file(agentId);
    return this.#lifecycle(agentId, async () => {
      try {
        const { chat, workspaces } = this.#options;
        chat.ensureAccount({
          externalId: agentId,
          displayName: spec.displayName,
          handle: spec.handle,
        });
        await workspaces.prepare(agentId);
        if (!existsSync(file)) await createAgentStore(file, spec.settings);
        await this.#start(agentId);
      } catch (error) {
        throw new AgentCreationFailed(agentId, error);
      }
      return agentId;
    });
  }

  /** Close the Agent's runtime, aborting its model requests and tool calls, and record it as paused. */
  pause(agentId: string): Promise<void> {
    const file = this.#files.file(agentId);
    return this.#lifecycle(agentId, async () => {
      await this.#stop(agentId);
      await setAgentPaused(file, true);
    });
  }

  /** Clear the pause and open the runtime; Durable continues where it stopped. */
  resume(agentId: string): Promise<void> {
    const file = this.#files.file(agentId);
    return this.#lifecycle(agentId, async () => {
      await setAgentPaused(file, false);
      await this.#start(agentId);
    });
  }

  /** Close the Agent, deactivate its chat account, and remove its file. Its messages stay readable. */
  delete(agentId: string): Promise<void> {
    this.#files.file(agentId);
    return this.#lifecycle(agentId, async () => {
      await this.#stop(agentId);
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
    const agentIds = new Set([...this.#running.keys(), ...this.#queues.keys()]);
    await Promise.all(
      [...agentIds].map((agentId) => this.#serial(agentId, () => this.#stop(agentId))),
    );
  }

  #lifecycle<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("the Agent Manager is closed"));
    return this.#serial(agentId, work);
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

  /** Open the Agent unless it is open or paused. Runs in the Agent's queue. */
  async #start(agentId: string): Promise<void> {
    if (this.#running.has(agentId)) return;
    const file = this.#files.file(agentId);
    if ((await readAgentState(file)).paused) return;
    const { chat, workspaces, apiKey, resolveModel } = this.#options;
    // The chat app holds the account; the Agent ID is its external identity, so there is no second record of it.
    const account = chat.findAccount(agentId);
    if (account === undefined) throw new Error(`Agent ${agentId} has no chat account`);
    const report = (error: unknown) => this.#report(error, agentId);
    const runtime = await openAgentRuntime({
      file,
      apiKey,
      workspace: workspaces.port(agentId),
      chat: chatPort(chat, account),
      clock: this.#clock,
      onFatal: report,
      ...(resolveModel === undefined ? {} : { resolveModel }),
    });
    const inbox = await connectInbox({ chat, account, runtime, clock: this.#clock, report });
    this.#running.set(agentId, { runtime, inbox });
  }

  /** Stop the connector, then close the runtime. Runs in the Agent's queue. */
  async #stop(agentId: string): Promise<void> {
    const opened = this.#running.get(agentId);
    if (opened === undefined) return;
    this.#running.delete(agentId);
    await opened.inbox.stop();
    await opened.runtime.close();
  }

  #report(error: unknown, agentId: string): void {
    (this.#options.report ?? defaultReport)(error, agentId);
  }
}

function defaultReport(error: unknown, agentId: string): void {
  console.error(`Agent ${agentId}:`, error);
}
