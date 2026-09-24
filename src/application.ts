import { Directory } from "./slack/directory.js";
import { SlackHistory } from "./slack/history.js";
import { Attachments } from "./slack/attachments.js";
import { slackApplication } from "./slack/application.js";
import { CanonicalSlackTransport } from "./slack/transport.js";
import { Artifacts } from "./daemon/artifacts.js";
import { Controls } from "./daemon/control.js";
import { Research } from "./daemon/research.js";
import { LocalAdapter } from "./local/input.js";
import type { LocalSettings } from "./local/rooms.js";
import { Broker } from "./policy/broker.js";
import { SystemOperations } from "./policy/system-operations.js";
import type { PrivilegedExecutor } from "./policy/system-operations.js";
import { PrivilegedBackend } from "./execution/privileged.js";
import { AdmittedBackend } from "./execution/admitted.js";
import type { ExecutionBackend } from "./execution/backend.js";
import type { LinuxProcessManager } from "./execution/linux-processes.js";
import { FairAdmission } from "./concurrency/admission.js";
import { EnvironmentCapabilities } from "./capabilities/environment.js";
import { Supervisor } from "./runtime/supervisor.js";
import type { Worker } from "./runtime/supervisor.js";
import { ToolRouter } from "./runtime/tools.js";
import { defaultRuntimeLimits, type RuntimeLimits } from "./runtime/limits.js";
import { ConfiguredAgents } from "./agents/directory.js";
import { Collaboration } from "./collaboration/service.js";
import { CanonicalAttention } from "./conversations/attention.js";
import { CanonicalFreshnessGate } from "./conversations/freshness.js";
import { Conversations } from "./conversations/messages.js";
import { CanonicalOutput } from "./conversations/output.js";
import type {
  ArtifactTransportProvider,
  ExternalMessageTransport,
} from "./conversations/output.js";
import { References } from "./conversations/references.js";
import { TeamDirectory } from "./conversations/team-directory.js";
import { CanonicalWrites } from "./storage/conversation-writes.js";
import { ConversationRecords } from "./storage/conversations.js";
import type { Store } from "./storage/store.js";
import type { MateConfig } from "./config.js";
import type { AgentDefinition, TeamSettings } from "./domain/agents.js";

/** Runtime limits, shared work root, privileged eligibility and research hosts. */
export interface ApplicationRuntime {
  limits: RuntimeLimits;
  sharedRoot?: string;
  systemAgents?: readonly string[];
  researchHosts: readonly string[];
}
/** External Slack facilities this entry owns, including the artifact adapter created later. */
export interface SlackPorts {
  config: MateConfig;
  artifacts: ArtifactTransportProvider;
}
/** What an entry supplies from outside the application: host identity and external adapters. */
export interface ApplicationPorts {
  /** Ordinary file, command and process execution identity for every Agent. */
  backend: ExecutionBackend;
  /** Private workspace of each Agent, keyed by Agent id. */
  memoryRoots: Record<string, string>;
  slack?: SlackPorts;
  privileged?: PrivilegedExecutor;
  linuxProcesses?: LinuxProcessManager;
  workerFactory?: (agent: AgentDefinition) => Worker;
  /** Read one Agent's private memory entry for run recovery. */
  recoverMemory?: (agentId: string, workId: string, signal: AbortSignal) => Promise<string>;
  reviewWorkspace?: (actor: string) => string;
  controlProjection?: (
    user: string,
    command: string,
    id: string | undefined,
    args: string[],
  ) => string | undefined;
  clock?: () => number;
}
export interface ApplicationInput {
  store: Store;
  /** Agents, owners and the run timeout this application serves. */
  team: TeamSettings;
  /** Local JSONL adapter; absent when this application serves no local console. */
  local?: LocalSettings;
  runtime?: Partial<ApplicationRuntime>;
  ports: ApplicationPorts;
}

/** A local-only application refuses external publication instead of dropping it silently. */
const unavailableTransport: ExternalMessageTransport = {
  post: async () => {
    throw new Error("External transport unavailable");
  },
  pendingInput: () => false,
  classify: () => ({ kind: "rejected", reason: "External transport unavailable" }),
};

/**
 * One application assembly. Every entry — the daemon, the local JSONL development entry and
 * embedded harnesses — builds the same complete application here. An entry hands over the open
 * database, host identities and external adapters it owns; it receives collaborators that are
 * already wired, including the freshness gate and the artifact transport the core publishes
 * through, so no caller installs a missing collaborator after construction.
 */
export class Application {
  readonly attention: CanonicalAttention;
  readonly gate: CanonicalFreshnessGate;
  readonly messages: Conversations;
  readonly output: CanonicalOutput;
  readonly collaboration: Collaboration;
  readonly system: SystemOperations;
  readonly broker: Broker;
  readonly artifacts: Artifacts;
  readonly router: ToolRouter;
  readonly supervisor: Supervisor;
  readonly controls: Controls;
  readonly local: LocalAdapter | undefined;
  readonly directory: TeamDirectory;
  readonly memoryRoots: Record<string, string>;
  /** External message transport with its Slack clients; absent for a local-only application. */
  readonly transport: CanonicalSlackTransport | undefined;
  /** Admitted ordinary-execution backend every file, command and process tool goes through. */
  readonly backend: ExecutionBackend;
  static create(input: ApplicationInput): Application {
    return new Application(input);
  }
  private constructor(input: ApplicationInput) {
    const { store, team, ports } = input,
      runtime: ApplicationRuntime = {
        limits: input.runtime?.limits ?? defaultRuntimeLimits,
        researchHosts: input.runtime?.researchHosts ?? [],
        ...(input.runtime?.sharedRoot ? { sharedRoot: input.runtime.sharedRoot } : {}),
        ...(input.runtime?.systemAgents ? { systemAgents: input.runtime.systemAgents } : {}),
      },
      clock = ports.clock ?? Date.now,
      slack = ports.slack;
    // One message layer: the Slack adapter's canonical mapper, or the core-only composition.
    const slackApp = slack ? slackApplication(store, slack.config, team) : undefined;
    this.messages = slackApp?.messages ?? coreConversations(store, team);
    this.messages.writes.assertFormat();
    // Freshness needs the one attention instance this application uses. The gate built from it
    // is wired into the output and the tool router at construction, never installed afterwards.
    this.attention = new CanonicalAttention(this.messages);
    this.gate = new CanonicalFreshnessGate(this.messages, this.attention, clock);
    this.transport =
      slackApp && slack ? new CanonicalSlackTransport(store, slackApp.mapper) : undefined;
    this.output = new CanonicalOutput(
      this.messages,
      this.transport ?? unavailableTransport,
      clock,
      this.gate,
      slack?.artifacts ?? (() => undefined),
    );
    this.collaboration = new Collaboration(store, this.messages, this.output, team, this.attention);
    this.system = new SystemOperations(
      store,
      this.collaboration,
      runtime.systemAgents ?? [],
      ports.privileged ?? new PrivilegedBackend(),
      clock,
    );
    const admittedBackend = new AdmittedBackend(
      ports.backend,
      new FairAdmission(runtime.limits.maxBackendOperations),
    );
    this.backend = admittedBackend;
    this.memoryRoots = ports.memoryRoots;
    this.broker = new Broker(store, this.collaboration, admittedBackend, this.memoryRoots);
    this.artifacts = new Artifacts(
      this.collaboration,
      this.broker,
      slack?.artifacts ?? (() => undefined),
      this.memoryRoots,
    );
    const transport = this.transport,
      attachments = transport
        ? new Attachments(this.collaboration, this.broker, transport.clients)
        : undefined,
      environment = new EnvironmentCapabilities(this.collaboration, {
        homes: this.memoryRoots,
        ...(runtime.sharedRoot ? { sharedRoot: runtime.sharedRoot } : {}),
        access: process.platform === "linux" ? "linux_user_permissions" : "local_user_permissions",
        researchHosts: runtime.researchHosts,
        attachmentConfigured: (actor) => attachments?.configured(actor) ?? false,
        artifactConfigured: (actor) => this.artifacts.configured(actor),
        artifactSupported: (actor, target) => this.artifacts.supports(actor, target),
      }),
      research = new Research([...runtime.researchHosts]),
      directory = new TeamDirectory(
        this.messages,
        transport ? new Directory(this.messages, transport.clients, transport.mapper) : undefined,
      );
    this.directory = directory;
    this.router = new ToolRouter(
      this.collaboration,
      this.broker,
      {
        attachment: (...args) => {
          if (!attachments) throw new Error("Attachment adapter unavailable");
          return attachments.save(...args);
        },
        environment: (run, workId) => environment.read(run, workId),
        ...(ports.linuxProcesses ? { processes: ports.linuxProcesses } : {}),
        system: this.system,
        research: (url, signal) => research.read(url, signal),
        publish: (...args) => this.artifacts.publish(...args),
      },
      directory,
      (value) => slackApp?.argumentsCodec.args(value) ?? value,
      transport ? new SlackHistory(this.messages, transport) : undefined,
    );
    this.supervisor = new Supervisor(
      this.collaboration,
      this.router,
      team,
      ports.workerFactory,
      ports.recoverMemory ?? this.recoverMemory(admittedBackend),
      {
        runAdmission: new FairAdmission(runtime.limits.maxActiveRuns),
        workerIdleMs: runtime.limits.workerIdleMs,
      },
    );
    this.controls = new Controls(
      this.collaboration,
      this.supervisor,
      this.broker,
      ports.reviewWorkspace,
      ports.controlProjection,
      ports.linuxProcesses,
      this.system,
    );
    this.local = input.local ? new LocalAdapter(this.collaboration, input.local.humans) : undefined;
  }
  /** Shutdown step: stop accepting runs and abort the queued and active ones, which also
   * collects the local worker processes this application owns. */
  stopAdvancing(): void {
    this.supervisor.close();
  }
  /** Shutdown step: wait for tool and delegation work already started here to settle. */
  async drainWork(): Promise<void> {
    await this.supervisor.drain();
  }
  /** Shutdown step, before the database is released: every external effect this process can no
   * longer confirm becomes a persistent unknown result its owner can still verify. */
  fenceUnconfirmedEffects(): void {
    this.system.fenceUnconfirmed();
    this.collaboration.store.fenceUnconfirmedEffects();
  }
  private recoverMemory(backend: ExecutionBackend) {
    return async (agentId: string, _workId: string, signal: AbortSignal): Promise<string> => {
      const root = this.memoryRoots[agentId];
      // An embedded application without a provisioned private workspace has no memory to recover.
      if (!root) return "";
      const result = await backend.execute(
        { agentId, root, operation: { kind: "read", path: "MEMORY.md" }, timeoutMs: 10000 },
        signal,
      );
      if (result.code !== 0 || result.truncated)
        throw new Error("Private memory recovery read failed");
      return result.stdout;
    };
  }
}

/** Core-only message layer for applications that serve no external adapter. */
function coreConversations(store: Store, team: TeamSettings): Conversations {
  const references = new References(store);
  return new Conversations(
    store,
    new ConfiguredAgents(team.agents),
    references,
    new ConversationRecords(store, references),
    new CanonicalWrites(store, references),
    { participates: () => true },
    undefined,
    () => {
      throw new Error("External publication unavailable");
    },
  );
}
