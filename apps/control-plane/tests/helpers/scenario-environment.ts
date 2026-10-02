import { agentSummarySchema, ownerChannelSchema } from "@mate/protocol/owner";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ProviderRequest } from "./agent-loop.js";
import { ProcessOutput, login, ownerPassword, stopProcess } from "./run-services.js";

const agentConfigurationSchema = z.object({
  name: z.string().min(1),
  role: z.string().default("持续工作"),
  description: z.string().default("Synthetic scenario Agent"),
  model: z.object({ provider: z.literal("openai"), id: z.string() }).default({
    provider: "openai",
    id: "gpt-4o-mini",
  }),
});
const configurationSchema = z.object({
  cleanupTimeoutMs: z.number().int().positive().default(5000),
  agents: z.array(agentConfigurationSchema).default([]),
  controlPlane: z
    .object({
      nodeOperationTimeoutMs: z.number().int().positive().optional(),
      modelContextWindow: z.number().int().positive().optional(),
    })
    .default({}),
  node: z
    .object({
      commandTimeoutMs: z.number().int().positive().default(700),
      heartbeatIntervalMs: z.number().int().positive().default(100),
      heartbeatTimeoutMs: z.number().int().positive().default(2000),
      fileBoundary: z.enum(["before_execute", "before_receipt", "after_receipt"]).optional(),
      holdFirstFileExecution: z.boolean().default(false),
    })
    .prefault({}),
});
const providerRequestSchema = z
  .object({ input: z.array(z.unknown()), model: z.string() })
  .passthrough();
const preparedAgentSchema = z.object({
  summary: agentSummarySchema,
  channelId: z.string(),
  workspace: z.string(),
});

export type ScenarioConfiguration = z.input<typeof configurationSchema> & {
  provider: (request: ProviderRequest, response: ServerResponse) => void | Promise<void>;
  signal?: AbortSignal;
  resourceManifestPath?: string;
  observeProcess?: (service: "control-plane" | "node", output: ProcessOutput) => void;
  beforeClose?: (facts: ScenarioFacts, signal: AbortSignal) => void | Promise<void>;
};
export type PreparedScenarioAgent = z.infer<typeof preparedAgentSchema>;
export type ScenarioFacts = {
  directory: string;
  origin: string;
  nodeId: string;
  processes: readonly ProcessOutput[];
  agents: readonly PreparedScenarioAgent[];
  requests: readonly ProviderRequest[];
  redact: (text: string) => string;
  startupFailure?: unknown;
};
export type CleanupReport = {
  released: string[];
  failures: Array<{ resource: string; error: unknown }>;
};
type CleanupAction = (signal: AbortSignal) => void | Promise<void>;

function createCleanupResource(name: string, action: CleanupAction) {
  let inFlight: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let released = false;
  return {
    name,
    start() {
      if (released) return Promise.resolve();
      if (inFlight) return inFlight;
      const current = new AbortController();
      controller = current;
      inFlight = Promise.resolve()
        .then(() => action(current.signal))
        .then(
          () => {
            released = true;
          },
          (error: unknown) => {
            inFlight = undefined;
            throw error;
          },
        );
      return inFlight;
    },
    cancel(reason: Error) {
      controller?.abort(reason);
    },
  };
}

/** Startup keeps the original cause separate from best-effort cleanup results. */
export class ScenarioStartupError extends Error {
  constructor(
    cause: unknown,
    readonly directory: string,
    readonly processes: ProcessOutput[],
    readonly cleanup: CleanupReport,
    readonly close: () => Promise<CleanupReport>,
    readonly cleanupReports: readonly CleanupReport[],
  ) {
    super(`Scenario startup failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
}

/** A scenario owns only the services and synthetic directory it created. */
export async function createScenarioEnvironment(options: ScenarioConfiguration) {
  const configuration = configurationSchema.parse(options);
  const directory = mkdtempSync(join(tmpdir(), "mate-scenario-"));
  const ownership = randomUUID();
  const ownedProcesses: Array<{ pid: number; service: string; marker: string }> = [];
  const sensitiveValues = [ownerPassword, "synthetic-control-only-key"];
  function saveResources() {
    if (!options.resourceManifestPath) return;
    const manifest = {
      version: 1,
      directory,
      ownership,
      driverPid: process.pid,
      processes: ownedProcesses,
    };
    writeFileSync(`${options.resourceManifestPath}.tmp`, JSON.stringify(manifest), { mode: 0o600 });
    renameSync(`${options.resourceManifestPath}.tmp`, options.resourceManifestPath);
  }
  const resources = new Map<symbol, ReturnType<typeof createCleanupResource>>();
  const beforeClose = new Map<string, CleanupAction>();
  const cleanupReports: CleanupReport[] = [];
  function registerResource(name: string, release: CleanupAction) {
    resources.set(Symbol(name), createCleanupResource(name, release));
  }
  registerResource("synthetic directory", () =>
    rmSync(directory, { recursive: true, force: true }),
  );
  const requests: ProviderRequest[] = [];
  const pending = new Set<ServerResponse>();
  const providerErrors: unknown[] = [];
  const provider = createServer(async (request, response) => {
    pending.add(response);
    response.once("close", () => pending.delete(response));
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = providerRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
      requests.push(payload);
      await options.provider(payload, response);
    } catch (error) {
      providerErrors.push(error);
      response.destroy();
    }
  });
  registerResource("local provider", async () => {
    for (const response of pending) response.destroy();
    provider.closeAllConnections();
    // close() also cancels a pending listen/DNS lookup before the server has a handle.
    await new Promise<void>((resolveClose, reject) =>
      provider.close((error) => {
        if (error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) reject(error);
        else resolveClose();
      }),
    );
  });

  let origin = "";
  let cookie = "";
  let nodeId = "";
  let providerUrl = "";
  let startupFailure: unknown;
  let control: ProcessOutput | undefined;
  let node: ProcessOutput | undefined;
  let closing: Promise<CleanupReport> | undefined;
  let closed = false;
  let collectingEvidence = false;
  let restarting = false;
  const processes: ProcessOutput[] = [];
  const agents: PreparedScenarioAgent[] = [];
  const cancellation = new AbortController();
  const runner = fileURLToPath(new URL("./scenario-services.mjs", import.meta.url));

  function assertOpen() {
    cancellation.signal.throwIfAborted();
    if (closed) throw new Error("Scenario environment is closed");
  }

  async function cleanupAction(resource: ReturnType<typeof createCleanupResource>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        resource.start(),
        new Promise<void>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Scenario cleanup timed out: ${resource.name}`);
            resource.cancel(error);
            reject(error);
          }, configuration.cleanupTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function restartService(relaunch: () => Promise<void>) {
    assertOpen();
    if (restarting) throw new Error("Scenario service restart already in progress");
    restarting = true;
    try {
      await relaunch();
    } finally {
      restarting = false;
    }
  }

  function launch(service: "control-plane" | "node", environment: NodeJS.ProcessEnv) {
    assertOpen();
    const output = new ProcessOutput(
      spawn(process.execPath, [runner, service, ownership], {
        cwd: directory,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C.UTF-8",
          HOME: join(directory, "home"),
          TMPDIR: join(directory, "tmp"),
          ...environment,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    processes.push(output);
    if (output.child.pid)
      ownedProcesses.push({
        pid: output.child.pid,
        service,
        marker: `${runner} ${service} ${ownership}`,
      });
    registerResource(`${service} process ${processes.length}`, () => stopProcess(output));
    saveResources();
    options.observeProcess?.(service, output);
    return output;
  }

  function launchControl(port = 0) {
    control = launch("control-plane", {
      MATE_CONTROL_PLANE_PORT: String(port),
      MATE_CONTROL_PLANE_DATA_DIR: join(directory, "control-plane-data"),
      MATE_OWNER_PASSWORD_FILE: join(directory, "owner-password"),
      MATE_SCENARIO_PROVIDER_URL: providerUrl,
      ...(configuration.controlPlane.modelContextWindow === undefined
        ? {}
        : {
            MATE_SCENARIO_MODEL_CONTEXT_WINDOW: String(
              configuration.controlPlane.modelContextWindow,
            ),
          }),
      ...(configuration.controlPlane.nodeOperationTimeoutMs === undefined
        ? {}
        : {
            MATE_SCENARIO_NODE_OPERATION_TIMEOUT_MS: String(
              configuration.controlPlane.nodeOperationTimeoutMs,
            ),
          }),
    });
    return control;
  }

  function launchNode(pairingToken?: string) {
    node = launch("node", {
      MATE_CONTROL_PLANE_URL: origin,
      MATE_NODE_DATA_DIR: join(directory, "node-data"),
      MATE_NODE_AGENT_WORKSPACE_ROOT: join(directory, "workspaces"),
      MATE_SCENARIO_COMMAND_TIMEOUT_MS: String(configuration.node.commandTimeoutMs),
      MATE_SCENARIO_HEARTBEAT_INTERVAL_MS: String(configuration.node.heartbeatIntervalMs),
      MATE_SCENARIO_HEARTBEAT_TIMEOUT_MS: String(configuration.node.heartbeatTimeoutMs),
      ...(configuration.node.fileBoundary
        ? { MATE_SCENARIO_FILE_BOUNDARY: configuration.node.fileBoundary }
        : {}),
      ...(configuration.node.holdFirstFileExecution
        ? { MATE_SCENARIO_HOLD_FIRST_FILE_EXECUTION: "1" }
        : {}),
      ...(pairingToken ? { MATE_NODE_PAIRING_TOKEN: pairingToken } : {}),
    });
    return node;
  }

  const environment = {
    directory,
    get startupFailure() {
      return startupFailure;
    },
    redact(text: string) {
      return sensitiveValues.reduce(
        (result, secret) => (secret ? result.replaceAll(secret, "[REDACTED]") : result),
        text,
      );
    },
    requests,
    pending,
    providerErrors,
    processes,
    agents,
    cleanupReports,
    get resources() {
      return [...resources.values()].map((resource) => resource.name);
    },
    get origin() {
      return origin;
    },
    get nodeId() {
      return nodeId;
    },
    get control() {
      if (!control) throw new Error("Control plane has not started");
      return control;
    },
    get node() {
      if (!node) throw new Error("Node has not started");
      return node;
    },
    /** Register a scenario-owned resource immediately after creating it. Failed releases remain retryable. */
    registerCleanup(name: string, release: CleanupAction) {
      assertOpen();
      if ([...resources.values()].some((resource) => resource.name === name))
        throw new Error(`Scenario resource already registered: ${name}`);
      registerResource(name, release);
    },
    /** Evidence is captured while services and synthetic files still exist. */
    beforeClose(name: string, collect: CleanupAction) {
      assertOpen();
      if (beforeClose.has(name)) throw new Error(`Before-close action already registered: ${name}`);
      beforeClose.set(name, collect);
    },
    async request(
      path: string,
      input: { method?: string; body?: unknown; signal?: AbortSignal } = {},
    ) {
      if (!collectingEvidence) assertOpen();
      const response = await fetch(new URL(path, origin), {
        method: input.method ?? "GET",
        headers: { cookie, "content-type": "application/json" },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: AbortSignal.any([
          AbortSignal.timeout(15_000),
          ...(collectingEvidence ? [] : [cancellation.signal]),
          ...(input.signal ? [input.signal] : []),
        ]),
      });
      if (!response.ok)
        throw new Error(
          `${input.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`,
        );
      return response;
    },
    async prepareAgent(input: z.input<typeof agentConfigurationSchema>) {
      const profile = agentConfigurationSchema.parse(input);
      const created = z.object({ agent: agentSummarySchema }).parse(
        await (
          await environment.request("/api/owner/agents", {
            method: "POST",
            body: { ...profile, id: randomUUID(), nodeId },
          })
        ).json(),
      );
      if (!created.agent.linuxIdentity) throw new Error("Agent workspace was not prepared");
      const direct = z.object({ channel: ownerChannelSchema }).parse(
        await (
          await environment.request(`/api/owner/agents/${created.agent.id}/direct-channel`, {
            method: "POST",
          })
        ).json(),
      );
      const prepared = {
        summary: created.agent,
        channelId: direct.channel.id,
        workspace: created.agent.linuxIdentity.workspace,
      };
      agents.push(prepared);
      return prepared;
    },
    async restartNode() {
      return restartService(async () => {
        await stopProcess(node);
        await launchNode().waitFor(/MATE_NODE_CONNECTED/, 15_000, { signal: cancellation.signal });
      });
    },
    async restartControl() {
      return restartService(async () => {
        const port = Number(new URL(origin).port);
        const nodeCursor = environment.node.text.length;
        await stopProcess(control);
        await launchControl(port).waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/, 15_000, {
          signal: cancellation.signal,
        });
        cookie = await login(origin, cancellation.signal);
        sensitiveValues.push(cookie, cookie.slice(cookie.indexOf("=") + 1));
        await environment.node.waitFor(/MATE_NODE_CONNECTED/, 15_000, {
          after: nodeCursor,
          signal: cancellation.signal,
        });
      });
    },
    async close(): Promise<CleanupReport> {
      closed = true;
      cancellation.abort(new Error("Scenario environment closed"));
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      options.signal?.removeEventListener("abort", externalAbort);
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        const report: CleanupReport = { released: [], failures: [] };
        collectingEvidence = true;
        for (const [name, collect] of beforeClose) {
          try {
            await cleanupAction(createCleanupResource(`before close: ${name}`, collect));
          } catch (error) {
            report.failures.push({ resource: `before close: ${name}`, error });
          } finally {
            beforeClose.delete(name);
          }
        }
        collectingEvidence = false;
        for (const [id, resource] of [...resources].reverse()) {
          try {
            await cleanupAction(resource);
            resources.delete(id);
            report.released.push(resource.name);
          } catch (error) {
            report.failures.push({ resource: resource.name, error });
          }
        }
        cleanupReports.push(report);
        return report;
      });
      try {
        return await closing;
      } finally {
        closing = undefined;
      }
    },
  };

  if (options.beforeClose)
    beforeClose.set("scenario evidence", (signal) => options.beforeClose?.(environment, signal));

  function cancel(reason: unknown) {
    cancellation.abort(reason);
    void environment.close();
  }
  const interrupt = () => cancel(new Error("Scenario cancelled by SIGINT"));
  const terminate = () => cancel(new Error("Scenario cancelled by SIGTERM"));
  const externalAbort = () => cancel(options.signal?.reason);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) externalAbort();

  try {
    assertOpen();
    chmodSync(directory, 0o700);
    writeFileSync(join(directory, ".mate-scenario-owner"), ownership, { mode: 0o600 });
    saveResources();
    mkdirSync(join(directory, "home"), { mode: 0o700 });
    mkdirSync(join(directory, "tmp"), { mode: 0o700 });
    writeFileSync(join(directory, "owner-password"), `${ownerPassword}\n`, { mode: 0o600 });
    await new Promise<void>((resolveListen, reject) => {
      const finish = (error?: unknown) => {
        provider.removeListener("error", failed);
        cancellation.signal.removeEventListener("abort", aborted);
        if (error !== undefined) reject(error);
        else resolveListen();
      };
      const failed = (error: Error) => finish(error);
      const aborted = () => finish(cancellation.signal.reason);
      provider.once("error", failed);
      cancellation.signal.addEventListener("abort", aborted, { once: true });
      provider.listen(0, "127.0.0.1", () => {
        finish();
      });
    });
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Local provider has no port");
    providerUrl = `http://127.0.0.1:${address.port}/v1`;
    const listening = await launchControl().waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/, 15_000, {
      signal: cancellation.signal,
    });
    origin = `http://127.0.0.1:${listening[1]}`;
    cookie = await login(origin, cancellation.signal);
    sensitiveValues.push(cookie, cookie.slice(cookie.indexOf("=") + 1));
    const pairing = z
      .object({ pairingToken: z.string() })
      .parse(
        await (
          await environment.request("/api/owner/nodes/pairing-tokens", { method: "POST" })
        ).json(),
      );
    sensitiveValues.push(pairing.pairingToken);
    const paired = await launchNode(pairing.pairingToken).waitFor(
      /MATE_NODE_PAIRED ([0-9a-f-]+)/i,
      15_000,
      {
        signal: cancellation.signal,
      },
    );
    nodeId = z.string().parse(paired[1]);
    await environment.request("/api/owner/model-credentials/openai", {
      method: "PUT",
      body: { apiKey: "synthetic-control-only-key" },
    });
    for (const agent of configuration.agents) await environment.prepareAgent(agent);
    return environment;
  } catch (error) {
    startupFailure = error;
    const cleanup = await environment.close();
    throw new ScenarioStartupError(
      error,
      directory,
      processes,
      cleanup,
      environment.close,
      cleanupReports,
    );
  }
}
