import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { AccountNames, type ChatApp } from "@palace/chat";
import { systemClock, type Clock } from "@palace/clock";
import { NodeGatewayError, type NodeGateway, type NodeStatusResult } from "@palace/gateway";
import {
  AgentIdInUse,
  isAgentId,
  openAgentManager,
  type AgentDescription,
  type AgentManager,
} from "@palace/manager";
import {
  AgentStoreMissing,
  catalogModels,
  renderWebhookContent,
  type AgentEvent,
  type AgentRuntime,
  type AgentSettings,
  type CatalogModel,
  type EventWatch,
} from "@palace/runtime";
import { WorkspacePathSchema, type WorkspaceListing } from "@palace/node-protocol";
import { z } from "zod";
import { AdminError, parseInput } from "./admin-error.ts";
import { AdminStore } from "./store.ts";
import { gatewayWorkspaces } from "./workspaces.ts";

/** The providers Palace offers. Their models come from pi-ai's catalog. */
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

const WEBHOOK_TEXT_MAX_BYTES = 32 * 1024;

const WebhookInput = z.object({ name: z.string().trim().min(1).max(64) });

const DeliveryInput = z.object({
  text: z
    .string()
    .min(1)
    .refine((text) => Buffer.byteLength(text) <= WEBHOOK_TEXT_MAX_BYTES, "text is over 32 KiB"),
  key: z
    .string()
    .regex(/^[\x20-\x7e]{1,128}$/, "an idempotency key is 1 to 128 printable ASCII characters")
    .optional(),
});

const CredentialsInput = z.object({
  apiKey: z.string().trim().min(1),
  /** Replaces the catalog's base URL for every model of the provider, for a compatible proxy. */
  baseUrl: z.url({ protocol: /^https?$/ }).optional(),
});

/** What the admin module needs of the node gateway. */
export type AdminGateway = Pick<
  NodeGateway,
  "nodes" | "renameNode" | "createPairingToken" | "prepareWorkspace" | "runTool" | "browse"
>;

export type AdminOptions = {
  /** The control plane's data directory: the admin tables live in its control store, the Agents in `agents/`. */
  readonly dataDirectory: string;
  readonly chat: ChatApp;
  readonly gateway: AdminGateway;
  readonly clock?: Clock;
  /** Told about failed workspace preparation, Agent opening, connector passes, or runtime storage. */
  readonly report?: (error: unknown, agentId: string) => void;
};

/** An Agent's identity in chat, which is its chat account's. */
type AgentNames = {
  readonly accountId: number;
  readonly displayName: string;
  readonly handle: string;
};

/**
 * An Agent as an admin sees it: its names, and what its own file says. An Agent that cannot be described (its file
 * is unreadable, or it has no chat account) is listed with the problem, so an admin can delete it.
 */
export type AgentView =
  | (AgentNames &
      AgentDescription & {
        readonly nodeName: string;
        readonly grantedNodes: { nodeId: string; name: string }[];
      })
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

/** An inbound webhook as an admin sees it. Its secret is shown only when it is created or rotated. */
export type WebhookView = {
  readonly webhookId: string;
  readonly name: string;
  readonly createdAt: number;
};

/**
 * Open the admin module, and with it the Agent Manager on `<dataDirectory>/agents`, which opens every Agent that is
 * not paused. Agents' workspace tools run on their nodes through `gateway`; their model requests read the stored
 * credentials.
 */
export async function openAdmin(options: AdminOptions): Promise<Admin> {
  const store = new AdminStore(options.dataDirectory);
  try {
    const manager = await openAgentManager({
      directory: join(options.dataDirectory, "agents"),
      chat: options.chat,
      workspaces: gatewayWorkspaces(options.gateway, store),
      credentials: (provider) => store.credentials(provider),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.report === undefined ? {} : { report: options.report }),
    });
    return new Admin(options, store, manager);
  } catch (error) {
    store.close();
    throw error;
  }
}

/**
 * What an admin manages: Agents, providers and their keys, nodes. Every operation is one the `/api/admin/*` routes
 * make; inputs are parsed here, and a refusal is an `AdminError` that changed nothing. A create that failed part way
 * rejects with the Manager's `AgentCreationFailed`, whose `agentId` finishes it.
 */
export class Admin {
  readonly #chat: ChatApp;
  readonly #gateway: AdminGateway;
  readonly #store: AdminStore;
  readonly #manager: AgentManager;
  readonly #clock: Clock;
  readonly #report: NonNullable<AdminOptions["report"]>;

  constructor(options: AdminOptions, store: AdminStore, manager: AgentManager) {
    this.#chat = options.chat;
    this.#gateway = options.gateway;
    this.#store = store;
    this.#manager = manager;
    this.#clock = options.clock ?? systemClock;
    this.#report =
      options.report ?? ((error, agentId) => console.error(`Agent ${agentId}:`, error));
  }

  // ── Agents ──────────────────────────────────────────────────────────────────

  /** Every Agent, with its names, node, state, settings and usage. */
  async agents(): Promise<AgentView[]> {
    const accounts = new Map(
      this.#chat.listAccounts().map((account) => [account.accountId, account]),
    );
    const nodes = this.#gateway.nodes();
    const nodeNames = new Map(nodes.map((node) => [node.nodeId, node.name]));
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
          const description = await this.#manager.describe(agentId);
          const grantedNodes = nodes
            .filter(
              (node) =>
                this.#store.nodeAccess(agentId, description.nodeId, node.nodeId) === "visit",
            )
            .map(({ nodeId, name }) => ({ nodeId, name }));
          return {
            ...names,
            ...description,
            nodeName: nodeNames.get(description.nodeId) ?? description.nodeId,
            grantedNodes,
          };
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

  /** Close the Agent, deactivate its chat account, delete its file, grants and webhooks. Its messages stay readable. */
  async deleteAgent(agentId: string): Promise<void> {
    await this.#existing(agentId, (id) => this.#manager.delete(id));
    this.#store.deleteNodeGrants(agentId);
    this.#store.deleteWebhooks(agentId);
  }

  /** Persist access, then prepare on an online node. Offline or failed preparation is retried by the node on use. */
  async grantNode(agentId: string, nodeId: string): Promise<void> {
    await this.#changeNodeGrant(agentId, nodeId, async () => {
      this.#store.grantNode(agentId, nodeId, this.#clock.now());
      if (!this.#gateway.nodes().some((node) => node.nodeId === nodeId && node.online)) return;
      const result = await this.#gateway.prepareWorkspace(nodeId, agentId, "visit");
      if (result.isError)
        this.#report(
          new Error(
            `Preparing workspace on node ${nodeId}: ${result.content.map((part) => part.text).join("")}`,
          ),
          agentId,
        );
    });
  }

  /** Refuse later visits to this node without stopping calls that have already started. */
  async revokeNode(agentId: string, nodeId: string): Promise<void> {
    await this.#changeNodeGrant(agentId, nodeId, () => this.#store.revokeNode(agentId, nodeId));
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

  // ── Webhooks ────────────────────────────────────────────────────────────────

  /** The Agent's webhooks, open or closed Agent. */
  async webhooks(agentId: string): Promise<WebhookView[]> {
    return this.#existing(agentId, async (id) => this.#store.webhooksOf(id).map(webhookView));
  }

  /** Add a webhook that delivers to the Agent. The secret is returned here and never again. */
  async createWebhook(
    agentId: string,
    input: z.input<typeof WebhookInput>,
  ): Promise<WebhookView & { secret: string }> {
    const { name } = parseInput(WebhookInput, input);
    return this.#existing(agentId, async (id) => {
      const secret = newSecret();
      const record = {
        id: randomUUID(),
        agentId: id,
        name,
        secretHash: hashSecret(secret),
        createdAt: this.#clock.now(),
      };
      this.#store.addWebhook(record);
      return { ...webhookView(record), secret };
    });
  }

  /** Replace the webhook's secret; the old one stops working at once. The new secret is returned here and never again. */
  rotateWebhook(webhookId: string): { webhookId: string; secret: string } {
    const secret = newSecret();
    if (!this.#store.replaceWebhookSecret(webhookId, hashSecret(secret)))
      throw new AdminError("unknown-webhook", `no webhook ${webhookId}`);
    return { webhookId, secret };
  }

  deleteWebhook(webhookId: string): void {
    if (!this.#store.deleteWebhook(webhookId))
      throw new AdminError("unknown-webhook", `no webhook ${webhookId}`);
  }

  /**
   * Hand an outside system's message to the open Agent as an input of its primary conversation, steering a run in
   * progress and starting one otherwise. The content names the webhook and says when, so the model knows a human did
   * not write it. Admitted once per `requestId`: `webhook:<id>:<key>` with a key, so a retry with the same key changes
   * nothing, and a fresh one without. A webhook that does not exist, a wrong secret, and a webhook whose Agent is gone
   * are all `invalid-webhook`; a paused or closed Agent is `agent-closed`, and nothing is queued for it.
   */
  async deliverWebhook(
    webhookId: string,
    secret: string,
    input: z.input<typeof DeliveryInput> & { key?: string | undefined },
  ): Promise<{ requestId: string }> {
    const webhook = this.#store.webhook(webhookId);
    if (webhook === undefined || !secretIs(secret, webhook.secretHash)) throw invalidWebhook();
    const { text, key } = parseInput(DeliveryInput, input);
    const requestId = `webhook:${webhook.id}:${key ?? randomUUID()}`;
    const at = new Date(this.#clock.now())
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, " UTC");
    const content = renderWebhookContent({ name: webhook.name, id: webhook.id, at, text });
    try {
      await this.#whileOpen(webhook.agentId, (runtime) =>
        runtime.submit(content, { requestId, whenBusy: "steer" }),
      );
    } catch (error) {
      if (error instanceof AdminError && error.reason === "unknown-agent") throw invalidWebhook();
      throw error;
    }
    return { requestId };
  }

  // ── Providers and models ────────────────────────────────────────────────────

  /** Every provider Palace offers, and its stored credentials, masked. */
  providers(): ProviderView[] {
    return Provider.options.map((provider) => {
      const stored = this.#store.credentials(provider);
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
    this.#store.setCredentials(id, { apiKey, ...(baseUrl === undefined ? {} : { baseUrl }) });
  }

  /** Forget a provider's credentials. Agents on its models fail their requests until a key is stored again. */
  deleteCredentials(provider: string): void {
    this.#store.deleteCredentials(this.#provider(provider));
  }

  /** The models an Agent can be given: those of every provider with credentials. */
  models(): CatalogModel[] {
    return Provider.options
      .filter((provider) => this.#store.credentials(provider) !== undefined)
      .flatMap((provider) => catalogModels(provider));
  }

  // ── Nodes ───────────────────────────────────────────────────────────────────

  /** Every paired node and whether it is online. */
  nodes(): NodeStatusResult[] {
    return this.#gateway.nodes();
  }

  /** Change the name of a paired node; its identity and reported system information stay the same. */
  renameNode(nodeId: string, name: string): void {
    try {
      this.#gateway.renameNode(nodeId, name);
    } catch (error) {
      if (error instanceof NodeGatewayError) throw new AdminError(error.reason, error.message);
      throw error;
    }
  }

  /** A single-use token that pairs one new node. */
  createPairingToken(): { pairingToken: string; expiresAt: string } {
    return this.#gateway.createPairingToken();
  }

  /** Close every Agent, then the admin module's own connection to the control store. */
  async close(): Promise<void> {
    await this.#manager.close();
    this.#store.close();
  }

  async #changeNodeGrant(
    agentId: string,
    nodeId: string,
    change: () => void | Promise<void>,
  ): Promise<void> {
    await this.#existing(agentId, async (id) => {
      const { nodeId: homeNodeId } = await this.#manager.describe(id);
      if (!this.#gateway.nodes().some((node) => node.nodeId === nodeId))
        throw new AdminError("unknown-node", `no paired node ${nodeId}`);
      if (nodeId === homeNodeId)
        throw new AdminError("invalid-input", "the home node is always accessible");
      await change();
    });
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
    if (!parsed.success) throw new AdminError("unknown-provider", `Palace offers no ${provider}`);
    return parsed.data;
  }

  /** Settings an Agent may have: a model of a provider with a key, at a thinking level the model accepts. */
  #settings(input: z.output<typeof SettingsInput>): AgentSettings {
    const { model, thinkingLevel, instructions } = input;
    const provider = this.#provider(model.provider);
    if (this.#store.credentials(provider) === undefined)
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

const newSecret = () => randomBytes(32).toString("base64url");
const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("hex");

function secretIs(secret: string, expectedHash: string): boolean {
  return timingSafeEqual(Buffer.from(hashSecret(secret)), Buffer.from(expectedHash));
}

const invalidWebhook = () =>
  new AdminError("invalid-webhook", "no such webhook, or the secret is wrong");

function webhookView(record: { id: string; name: string; createdAt: number }): WebhookView {
  return { webhookId: record.id, name: record.name, createdAt: record.createdAt };
}

function mask(apiKey: string): string {
  return apiKey.length < 12 ? "…" : `…${apiKey.slice(-4)}`;
}
