import { join } from "node:path";
import { AccountNames, type ChatApp } from "@mate/chat";
import type { Clock } from "@mate/clock";
import type { NodeGateway, NodeStatusResult } from "@mate/gateway";
import {
  AgentIdInUse,
  isAgentId,
  openAgentManager,
  type AgentDescription,
  type AgentManager,
} from "@mate/manager";
import {
  AgentStoreMissing,
  catalogModels,
  type AgentEvent,
  type AgentRuntime,
  type AgentSettings,
  type CatalogModel,
  type EventWatch,
} from "@mate/runtime";
import { WorkspacePathSchema, type WorkspaceListing } from "@mate/node-protocol";
import { z } from "zod";
import { AdminError, parseInput } from "./admin-error.ts";
import { CredentialStore } from "./credentials.ts";
import { gatewayWorkspaces } from "./workspaces.ts";

/** The providers Mate offers. Their models come from pi-ai's catalog. */
const Provider = z.enum(["openai", "deepseek"]);
type ProviderId = z.output<typeof Provider>;
const PROVIDER_NAMES: Record<ProviderId, string> = { openai: "OpenAI", deepseek: "DeepSeek" };

const SettingsInput = z.object({
  model: z.object({ provider: z.string(), modelId: z.string() }),
  thinkingLevel: z.string().optional(),
  instructions: z.string().max(50_000).optional(),
});

const CreateAgentInput = AccountNames.extend({
  /** The ID of a create that failed, to finish that Agent. */
  agentId: z.string().refine(isAgentId, "an Agent ID is a lowercase UUID").optional(),
  nodeId: z.string().min(1),
  settings: SettingsInput,
});

const CredentialsInput = z.object({
  apiKey: z.string().trim().min(1),
  /** Replaces the catalog's base URL for every model of the provider, for a compatible proxy. */
  baseUrl: z.url({ protocol: /^https?$/ }).optional(),
});

/** What the admin module needs of the node gateway. */
export type AdminGateway = Pick<
  NodeGateway,
  "nodes" | "createPairingToken" | "prepareWorkspace" | "runTool" | "browse"
>;

export type AdminOptions = {
  /** The control plane's data directory: the admin tables live in its control store, the Agents in `agents/`. */
  readonly dataDirectory: string;
  readonly chat: ChatApp;
  readonly gateway: AdminGateway;
  readonly clock?: Clock;
  /** Told about an Agent that failed to open, a failed connector pass, or a runtime whose storage failed. */
  readonly report?: (error: unknown, agentId: string) => void;
};

/** An Agent's identity in chat, which is its chat account's. */
type AgentNames = {
  readonly accountId: number;
  readonly displayName: string;
  readonly handle: string;
};

/**
 * An Agent as the owner sees it: its names, and what its own file says. An Agent that cannot be described (its file
 * is unreadable, or it has no chat account) is listed with the problem, so the owner can delete it.
 */
export type AgentView =
  | (AgentNames & AgentDescription)
  | ({
      readonly agentId: string;
      readonly state: "unreadable";
      readonly problem: string;
    } & Partial<AgentNames>);

export type ProviderView = {
  readonly provider: ProviderId;
  readonly name: string;
  /** The stored key shows only its last four characters. */
  readonly credentials: { readonly apiKey: string; readonly baseUrl: string | null } | null;
};

/**
 * Open the admin module, and with it the Agent Manager on `<dataDirectory>/agents`, which opens every Agent that is
 * not paused. Agents' workspace tools run on their nodes through `gateway`; their model requests read the stored
 * credentials.
 */
export async function openAdmin(options: AdminOptions): Promise<Admin> {
  const credentials = new CredentialStore(options.dataDirectory);
  try {
    const manager = await openAgentManager({
      directory: join(options.dataDirectory, "agents"),
      chat: options.chat,
      workspaces: gatewayWorkspaces(options.gateway),
      credentials: (provider) => credentials.get(provider),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.report === undefined ? {} : { report: options.report }),
    });
    return new Admin(options, credentials, manager);
  } catch (error) {
    credentials.close();
    throw error;
  }
}

/**
 * What the owner manages: Agents, providers and their keys, nodes. Every operation is one the `/api/admin/*` routes
 * make; inputs are parsed here, and a refusal is an `AdminError` that changed nothing. A create that failed part way
 * rejects with the Manager's `AgentCreationFailed`, whose `agentId` finishes it.
 */
export class Admin {
  readonly #chat: ChatApp;
  readonly #gateway: AdminGateway;
  readonly #credentials: CredentialStore;
  readonly #manager: AgentManager;

  constructor(options: AdminOptions, credentials: CredentialStore, manager: AgentManager) {
    this.#chat = options.chat;
    this.#gateway = options.gateway;
    this.#credentials = credentials;
    this.#manager = manager;
  }

  // ── Agents ──────────────────────────────────────────────────────────────────

  /** Every Agent, with its names, node, state, settings and usage. */
  async agents(): Promise<AgentView[]> {
    const accounts = new Map(
      this.#chat.listAccounts().map((account) => [account.accountId, account]),
    );
    const views = await Promise.all(
      this.#manager.list().map(async ({ agentId }): Promise<AgentView | undefined> => {
        const account = this.#chat.findAccount(agentId);
        const view = account === undefined ? undefined : accounts.get(account);
        const names = view && {
          accountId: view.accountId,
          displayName: view.displayName,
          handle: view.handle,
        };
        try {
          if (names === undefined) throw new Error(`Agent ${agentId} has no chat account`);
          return { ...names, ...(await this.#manager.describe(agentId)) };
        } catch (error) {
          // Deleted since it was listed.
          if (error instanceof AgentStoreMissing) return undefined;
          return { ...names, agentId, state: "unreadable", problem: String(error) };
        }
      }),
    );
    return views.filter((view) => view !== undefined);
  }

  /**
   * Create an Agent on a paired node and open it. With the `agentId` of an `AgentCreationFailed`, finish that Agent.
   * The names and the settings are checked, as `configureAgent` checks settings, before anything is created. An ID that
   * names an Agent is refused with `agent-exists`, one that named a deleted Agent with the chat app's `inactive-account`,
   * and a handle in use with `handle-taken`: nothing exists yet, so these are plain refusals, not a create to finish.
   */
  async createAgent(input: z.input<typeof CreateAgentInput>): Promise<string> {
    const { agentId, nodeId, displayName, handle, settings } = parseInput(CreateAgentInput, input);
    if (!this.#gateway.nodes().some((node) => node.nodeId === nodeId))
      throw new AdminError("unknown-node", `no paired node ${nodeId}`);
    try {
      return await this.#manager.create({
        nodeId,
        displayName,
        handle,
        settings: this.#settings(settings),
        ...(agentId === undefined ? {} : { agentId }),
      });
    } catch (error) {
      if (error instanceof AgentIdInUse) throw new AdminError("agent-exists", error.message);
      throw error;
    }
  }

  /** Close the Agent, aborting its work, and keep it closed until it is resumed, across restarts too. */
  async pauseAgent(agentId: string): Promise<void> {
    await this.#existing(agentId, (id) => this.#manager.pause(id));
  }

  /** Open a paused or closed Agent; it continues where it stopped. */
  async resumeAgent(agentId: string): Promise<void> {
    await this.#existing(agentId, (id) => this.#manager.resume(id));
  }

  /** Close the Agent, deactivate its chat account, delete its file. Its messages stay readable. */
  async deleteAgent(agentId: string): Promise<void> {
    await this.#existing(agentId, (id) => this.#manager.delete(id));
  }

  /**
   * Change the Agent's model, thinking level and instructions, open or closed; a running Agent uses them from its next
   * model request. Only a provider with a key, a model in its catalog, and a thinking level that model accepts.
   */
  async configureAgent(agentId: string, input: z.input<typeof SettingsInput>): Promise<void> {
    await this.#existing(agentId, (id) =>
      this.#manager.configure(id, this.#settings(parseInput(SettingsInput, input))),
    );
  }

  /** The names of the open Agent's work assistants, each of which `watchAgent` can watch. */
  async assistants(agentId: string): Promise<string[]> {
    return this.#whileOpen(agentId, (runtime) => runtime.assistants());
  }

  /**
   * Watch the open Agent's primary conversation, or one of its assistants, live: the first batch is a snapshot, then
   * streamed text, tool calls and their output as they happen. Watching changes nothing. The watch ends when stopped,
   * or when the Agent closes (paused, deleted, the control plane stopping).
   */
  async watchAgent(
    agentId: string,
    listener: (events: readonly AgentEvent[]) => void | Promise<void>,
    options: { assistant?: string } = {},
  ): Promise<EventWatch> {
    const { assistant } = options;
    return this.#whileOpen(agentId, async (runtime) => {
      if (assistant !== undefined && !(await runtime.assistants()).includes(assistant))
        throw new AdminError("unknown-assistant", `Agent ${agentId} has no assistant ${assistant}`);
      return runtime.watchEvents(listener, options);
    });
  }

  /**
   * Read a directory's entries or a file's start in the Agent's workspace, on its node, open or closed. Nothing
   * changes. The node refuses a path that leaves the workspace; an offline node is refused as `node-offline`.
   */
  async browseWorkspace(agentId: string, path: string): Promise<WorkspaceListing> {
    const at = parseInput(WorkspacePathSchema, path);
    return this.#existing(agentId, async (id) => {
      const { nodeId } = await this.#manager.describe(id);
      const outcome = await this.#gateway.browse(nodeId, id, at);
      if (!outcome.ok) throw new AdminError(outcome.reason, outcome.message);
      return outcome.listing;
    });
  }

  // ── Providers and models ────────────────────────────────────────────────────

  /** Every provider Mate offers, and its stored credentials, masked. */
  providers(): ProviderView[] {
    return Provider.options.map((provider) => {
      const stored = this.#credentials.get(provider);
      return {
        provider,
        name: PROVIDER_NAMES[provider],
        credentials:
          stored === undefined
            ? null
            : { apiKey: mask(stored.apiKey), baseUrl: stored.baseUrl ?? null },
      };
    });
  }

  /**
   * Store a provider's credentials. Every Agent's next request to the provider uses them; a request in flight keeps
   * the ones it was sent with, so saving the same value again changes nothing for a running Agent.
   */
  setCredentials(provider: string, input: z.input<typeof CredentialsInput>): void {
    const id = this.#provider(provider);
    const { apiKey, baseUrl } = parseInput(CredentialsInput, input);
    this.#credentials.set(id, { apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) });
  }

  /** Forget a provider's credentials. Agents on its models fail their requests until a key is stored again. */
  deleteCredentials(provider: string): void {
    this.#credentials.delete(this.#provider(provider));
  }

  /** The models an Agent can be given: those of every provider with credentials. */
  models(): CatalogModel[] {
    return Provider.options
      .filter((provider) => this.#credentials.get(provider) !== undefined)
      .flatMap((provider) => catalogModels(provider));
  }

  // ── Nodes ───────────────────────────────────────────────────────────────────

  /** Every paired node and whether it is online. */
  nodes(): NodeStatusResult[] {
    return this.#gateway.nodes();
  }

  /** A single-use token that pairs one new node. */
  createPairingToken(): { pairingToken: string; expiresAt: string } {
    return this.#gateway.createPairingToken();
  }

  /** Close every Agent, then the admin module's own connection to the control store. */
  async close(): Promise<void> {
    await this.#manager.close();
    this.#credentials.close();
  }

  /**
   * Run `work` on the Agent `agentId`, which must exist. The Agent can be deleted while `work` waits in its queue, so
   * the Manager's `AgentStoreMissing` from there is the same refusal as an unknown ID.
   */
  async #existing<T>(agentId: string, work: (agentId: string) => Promise<T>): Promise<T> {
    const unknown = () => new AdminError("unknown-agent", `no Agent ${agentId}`);
    if (!isAgentId(agentId) || !this.#manager.list().some((agent) => agent.agentId === agentId))
      throw unknown();
    try {
      return await work(agentId);
    } catch (error) {
      throw error instanceof AgentStoreMissing ? unknown() : error;
    }
  }

  /**
   * Run `work` on the runtime of the open Agent `agentId`. A runtime that closes while `work` uses it (the Agent was
   * paused or deleted meanwhile) fails in ways of its own; that is the same refusal as an Agent that is not open.
   */
  async #whileOpen<T>(agentId: string, work: (runtime: AgentRuntime) => Promise<T>): Promise<T> {
    const runtime = await this.#existing(agentId, async (id) => this.#manager.runtime(id));
    const closed = () => new AdminError("agent-closed", `Agent ${agentId} is not open`);
    if (runtime === undefined) throw closed();
    try {
      return await work(runtime);
    } catch (error) {
      throw this.#manager.runtime(agentId) === runtime ? error : closed();
    }
  }

  #provider(provider: string): ProviderId {
    const parsed = Provider.safeParse(provider);
    if (!parsed.success) throw new AdminError("unknown-provider", `Mate offers no ${provider}`);
    return parsed.data;
  }

  /** Settings an Agent may have: a model of a provider with a key, at a thinking level the model accepts. */
  #settings(input: z.output<typeof SettingsInput>): AgentSettings {
    const { model, thinkingLevel, instructions } = input;
    const provider = this.#provider(model.provider);
    if (this.#credentials.get(provider) === undefined)
      throw new AdminError("no-credentials", `${PROVIDER_NAMES[provider]} has no API key`);
    const found = catalogModels(provider).find((each) => each.modelId === model.modelId);
    if (found === undefined)
      throw new AdminError(
        "unknown-model",
        `${PROVIDER_NAMES[provider]} has no model ${model.modelId}`,
      );
    const level = found.thinkingLevels.find((each) => each === thinkingLevel);
    if (thinkingLevel !== undefined && level === undefined)
      throw new AdminError(
        "unsupported-thinking-level",
        `${found.name} accepts thinking levels ${found.thinkingLevels.join(", ")}, not ${thinkingLevel}`,
      );
    return {
      model: { provider, modelId: found.modelId },
      ...(level === undefined ? {} : { thinkingLevel: level }),
      ...(instructions === undefined ? {} : { instructions }),
    };
  }
}

function mask(apiKey: string): string {
  return apiKey.length < 12 ? "…" : `…${apiKey.slice(-4)}`;
}
