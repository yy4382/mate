import { ownerChannelSchema } from "@mate/protocol/owner";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { arch, release } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createScenarioDriver } from "./scenario-driver.js";
import {
  createScenarioEnvironment,
  ScenarioStartupError,
  type CleanupReport,
  type ScenarioConfiguration,
  type ScenarioFacts,
} from "./scenario-environment.js";
import { readNodeScenarioFacts, readScenarioFacts } from "./scenario-facts.js";
import { readNetworkQueueFacts } from "./scenario-network-facts.js";
import type { createScriptedProvider } from "./scripted-provider.js";

const credentialNamePattern = String.raw`(?:password|cookie|set[_-]?cookie|authorization|(?:api|secret|private)[_-]?key|(?:(?:pairing|download|access|refresh|session|csrf)[_-]?)?token|credentials?)`;
const credentialField = new RegExp(`^${credentialNamePattern}$`, "i");
const credentialAssignment = new RegExp(
  `(["']?${credentialNamePattern}["']?\\s*[:=]\\s*)(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s,;}]+)`,
  "gi",
);

type Provider = ReturnType<typeof createScriptedProvider>;
type Environment = Awaited<ReturnType<typeof createScenarioEnvironment>>;
export type ScenarioContext = {
  evidenceDirectory: string;
  environment: Environment;
  driver: ReturnType<typeof createScenarioDriver>;
  signal: AbortSignal;
  step: <T>(name: string, action: () => T | Promise<T>) => Promise<T>;
  effectFile: (name: string, path: string) => void;
};

export class ScenarioFailure extends Error {
  constructor(
    cause: unknown,
    readonly evidenceDirectory: string,
    readonly evidenceErrors: unknown[],
    readonly cleanup: readonly CleanupReport[],
    readonly close: () => Promise<CleanupReport>,
  ) {
    super(`Scenario failed; evidence: ${evidenceDirectory}`, { cause });
  }
}

/** Persist projections and explicit synthetic effects, never credentials, databases or directories. */
export async function runScenario<T>(options: {
  name: string;
  provider: Provider;
  environment?: Omit<
    ScenarioConfiguration,
    "provider" | "signal" | "beforeClose" | "resourceManifestPath"
  >;
  evidenceRoot?: string;
  signal?: AbortSignal;
  run: (context: ScenarioContext) => T | Promise<T>;
}) {
  const root = resolve(
    options.evidenceRoot ??
      join(
        execFileSync("git", ["rev-parse", "--show-toplevel"]).toString().trim(),
        "artifacts/scenarios",
      ),
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const evidenceDirectory = mkdtempSync(join(root, "scenario-"));
  const checkout = {
    dirty: execFileSync("git", ["status", "--porcelain"]).toString().trim() !== "",
    sha: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
    platform: process.platform,
    arch: arch(),
    kernel: release(),
  };
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  let failure: unknown;
  let failed = false;
  let environment: Environment | undefined;
  let lastEvent: { name: string; facts: unknown } | undefined;
  const assertions: Array<{ name: string; status: "passed" | "failed" }> = [];
  const effects = new Map<string, string>();
  const evidenceErrors: unknown[] = [];
  let redactEvidence: (value: unknown) => unknown = (value) =>
    value instanceof Error ? { name: value.name } : undefined;
  const rememberFailure = (error: unknown) => {
    if (!failed) {
      failure = error;
      failed = true;
    }
  };
  const interrupt = () => {
    const reason = new Error("Scenario cancelled by SIGINT");
    rememberFailure(reason);
    controller.abort(reason);
  };
  const terminate = () => {
    const reason = new Error("Scenario cancelled by SIGTERM");
    rememberFailure(reason);
    controller.abort(reason);
  };
  const externalAbort = () => rememberFailure(signal.reason);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  signal.addEventListener("abort", externalAbort, { once: true });

  async function collect(facts: ScenarioFacts, collectionSignal: AbortSignal) {
    if (facts.startupFailure !== undefined) rememberFailure(facts.startupFailure);
    let visited = new WeakSet<object>();
    function redact(value: unknown): unknown {
      if (value && typeof value === "object") {
        if (visited.has(value)) return "[Circular]";
        visited.add(value);
      }
      if (value instanceof Error)
        return {
          name: value.name,
          message: redact(value.message),
          stack: redact(value.stack),
          cause: redact(value.cause),
        };
      if (typeof value === "string") {
        const text = facts
          .redact(value)
          .replace(
            /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
            "[REDACTED PRIVATE KEY]",
          )
          .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed && typeof parsed === "object") return JSON.stringify(redact(parsed));
        } catch {
          /* Ordinary synthetic text. */
        }
        return text.replace(credentialAssignment, "$1[REDACTED]");
      }
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            credentialField.test(key) ? "[REDACTED]" : redact(entry),
          ]),
        );
      return value;
    }
    redactEvidence = (value) => {
      visited = new WeakSet<object>();
      return redact(value);
    };
    function save(name: string, value: unknown, checkDeadline = true) {
      if (checkDeadline) collectionSignal.throwIfAborted();
      writeFileSync(
        join(evidenceDirectory, name),
        `${JSON.stringify(redactEvidence(value), null, 2)}\n`,
        {
          mode: 0o600,
        },
      );
    }
    function attempt(action: () => void) {
      try {
        action();
      } catch (error) {
        evidenceErrors.push(error);
      }
    }
    let persistent: ReturnType<typeof readScenarioFacts> | undefined;
    function saveSummary() {
      save(
        "summary.json",
        {
          name: options.name,
          checkout,
          assertions,
          lastEvent,
          error: failure,
          evidenceErrors,
          providerErrors: options.provider.errors,
          nodeId: facts.nodeId,
          runs: persistent?.runs,
          operations: persistent?.operations,
          agents: facts.agents.map((agent) => ({
            agentId: agent.summary.id,
            sessionId: agent.summary.sessionId,
            channelId: agent.channelId,
          })),
          processes: facts.processes.map((output) => ({
            pid: output.child.pid,
            exitStatus: output.exitStatus ?? null,
            spawnError: output.spawnError,
            output: output.text,
          })),
        },
        false,
      );
    }
    attempt(saveSummary);
    attempt(() =>
      save(
        "model-requests.json",
        options.provider.requests.map((request, index) => ({
          sequence: index + 1,
          agentId: request.agentId,
          sessionId: request.sessionId,
          kind: request.kind,
          step: request.step,
          state: request.state,
          payload: request.payload,
        })),
      ),
    );
    attempt(() => {
      persistent = readScenarioFacts(facts.directory);
      save("persistent-facts.json", persistent);
    });
    attempt(() => save("node-facts.json", readNodeScenarioFacts(facts.directory)));
    attempt(() => save("network.json", facts.network ?? []));
    attempt(() =>
      save(
        "network-queues.json",
        facts.agents.map((agent) => ({
          agentId: agent.summary.id,
          ...readNetworkQueueFacts(facts.directory, agent.summary.id),
        })),
      ),
    );
    if (environment) {
      const driver = createScenarioDriver(environment);
      try {
        const channels = z
          .object({ channels: z.array(ownerChannelSchema) })
          .parse(
            await (
              await environment.request("/api/owner/channels", { signal: collectionSignal })
            ).json(),
          ).channels;
        for (const channel of channels) {
          try {
            const messages = await driver.messages(channel.id, collectionSignal);
            const threads = [];
            for (const message of messages)
              if (message.replyCount > 0)
                threads.push(await driver.thread(channel.id, message.id, collectionSignal));
            save(`channel-${channel.id}.json`, {
              channel,
              messages,
              threads,
              attachments: await driver.attachments(channel.id, collectionSignal),
            });
          } catch (error) {
            evidenceErrors.push(error);
          }
        }
      } catch (error) {
        evidenceErrors.push(error);
      }
      for (const agent of facts.agents) {
        try {
          save(`owner-${agent.summary.id}.json`, {
            messages: await driver.messages(agent.channelId, collectionSignal),
            attachments: await driver.attachments(agent.channelId, collectionSignal),
            activity: await driver.activity(agent.summary.id, 0, collectionSignal),
            tasks: await driver.tasks(collectionSignal),
          });
        } catch (error) {
          evidenceErrors.push(error);
        }
      }
    }
    for (const [name, path] of effects)
      attempt(() => {
        const actualPath = realpathSync(path);
        if (
          !facts.agents.some((agent) => {
            const child = relative(realpathSync(agent.workspace), actualPath);
            return (
              child !== "" && !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`)
            );
          })
        )
          throw new Error(`Effect is outside this scenario's Agent workspaces: ${name}`);
        const destination = join(evidenceDirectory, "effects", name);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        const bytes = readFileSync(actualPath);
        const text = bytes.toString("utf8");
        const clean = redactEvidence(text);
        if (typeof clean !== "string") throw new Error("Unexpected effect redaction");
        writeFileSync(destination, clean === text ? bytes : clean, { mode: 0o600 });
      });
    attempt(saveSummary);
  }

  let result: T | undefined;
  const cleanup: CleanupReport[] = [];
  let close = async (): Promise<CleanupReport> => ({ released: [], failures: [] });
  let removeAbort = () => {};
  try {
    signal.throwIfAborted();
    environment = await createScenarioEnvironment({
      ...options.environment,
      provider: options.provider.handle,
      signal,
      resourceManifestPath: join(evidenceDirectory, "resources.json"),
      beforeClose: collect,
    });
    close = environment.close;
    environment.registerCleanup("scripted provider", () => options.provider.close());
    const cancelled = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal.reason);
      removeAbort = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    result = await Promise.race([
      Promise.resolve(
        options.run({
          environment,
          evidenceDirectory,
          driver: createScenarioDriver(environment),
          signal,
          async step(name, action) {
            signal.throwIfAborted();
            try {
              const facts = await action();
              assertions.push({ name, status: "passed" });
              lastEvent = { name, facts };
              return facts;
            } catch (error) {
              assertions.push({ name, status: "failed" });
              rememberFailure(error);
              throw error;
            }
          },
          effectFile(name, path) {
            if (
              isAbsolute(name) ||
              name.split(/[\\/]/).some((part) => part === ".." || part === "")
            )
              throw new Error("Evidence effect name must be a relative file name");
            effects.set(name, path);
          },
        }),
      ),
      cancelled,
    ]);
  } catch (error) {
    rememberFailure(error instanceof ScenarioStartupError ? error.cause : error);
    if (error instanceof ScenarioStartupError) {
      close = error.close;
      cleanup.push(...error.cleanupReports);
    }
  } finally {
    if (environment) {
      await environment.close();
      cleanup.push(...environment.cleanupReports);
    } else await options.provider.close();
    removeAbort();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    signal.removeEventListener("abort", externalAbort);
  }
  if (evidenceErrors.length || cleanup.some((report) => report.failures.length)) {
    if (!failed) rememberFailure(new Error("Scenario evidence or cleanup failed"));
  }
  if (failed) {
    // Summary was saved before teardown; final report adds cleanup outcomes after resource releases.
    try {
      writeFileSync(
        join(evidenceDirectory, "cleanup.json"),
        `${JSON.stringify(
          cleanup.map((report) => ({
            released: report.released,
            failures: report.failures.map(({ resource, error }) => ({
              resource,
              error: redactEvidence(error),
            })),
          })),
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
    } catch (error) {
      evidenceErrors.push(error);
    }
    console.error(`MATE_SCENARIO_EVIDENCE ${evidenceDirectory}`);
    throw new ScenarioFailure(failure, evidenceDirectory, evidenceErrors, cleanup, close);
  }
  rmSync(evidenceDirectory, { recursive: true, force: true });
  return result;
}
