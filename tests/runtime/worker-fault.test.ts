import { afterEach, expect, it } from "vitest";
import { Store } from "../../src/storage/store.js";
import { configSchema } from "../../src/config.js";
import { configFixture } from "../helpers/config.js";
import { Messages, Output, fixtureTarget } from "../helpers/canonical-slack.js";
import { Collaboration } from "../../src/collaboration/service.js";
import { CanonicalAttention } from "../../src/conversations/attention.js";
import { CanonicalFreshnessGate } from "../../src/conversations/freshness.js";
import { Broker } from "../../src/policy/broker.js";
import { Supervisor } from "../../src/runtime/supervisor.js";
import { WorkerClient } from "../../src/runtime/client.js";
import { ToolRouter } from "../../src/runtime/tools.js";
import {
  faultOf,
  refusal,
  retryDisposition,
  type FaultCategory,
  type WorkerFault,
} from "../../src/runtime/fault.js";
import { createInitialSystemMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { toolDefinition } from "../../src/runtime/engine.js";
import { providerId } from "../helpers/fault-model.js";

/** The compiled fixture is the only synthetic subprocess entrypoint, as in the other worker tests. */
const fixture = new URL("../../dist/tests/helpers/fault-worker.js", import.meta.url);
/** The identity the caller and the worker fixture must agree on for the catalog lookup to resolve. */
const faultModel = { provider: providerId, id: "synthetic" };
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

/** A real worker process entry, spawned exactly as production does; only the scenario differs. */
function spawn(scenario: string, journal?: (message: never) => Promise<void>): WorkerClient {
  const worker = new WorkerClient(faultModel.provider, faultModel.id, `key-${scenario}`, fixture, {
    MATE_FAULT_SCENARIO: scenario,
  });
  if (journal) {
    const run = worker.run.bind(worker);
    worker.run = (spec, hooks, timeoutMs, signal) =>
      run(spec, { ...hooks, journal }, timeoutMs, signal);
  }
  cleanups.push(() => worker.close());
  return worker;
}
function setup(scenario: string, journal?: (message: never) => Promise<void>) {
  const config = configSchema.parse(configFixture);
  const store = new Store(":memory:"),
    messages = new Messages(store, config);
  const attention = new CanonicalAttention(messages),
    output = new Output(
      messages,
      { post: async () => ({ ts: "100.000002" }) },
      Date.now,
      new CanonicalFreshnessGate(messages, attention),
    ),
    collaboration = new Collaboration(store, messages, output, config, attention);
  const broker = new Broker(
    store,
    collaboration,
    { execute: async () => ({ code: 0, stdout: "", stderr: "", truncated: false }) },
    { research: "/tmp" },
  );
  const router = new ToolRouter(collaboration, broker);
  const supervisor = new Supervisor(collaboration, router, config, () => spawn(scenario, journal));
  supervisor.register();
  messages.membership(config.agents[0]!.id, "CTEST", true);
  const work = collaboration.createWork("human:one", fixtureTarget("CTEST", "100.000001"));
  cleanups.push(() => {
    supervisor.close();
    store.close();
  });
  return { store, collaboration, supervisor, router, config, work };
}
function recordedFault(store: Store): WorkerFault {
  const row = store.db
    .prepare("SELECT body FROM audit WHERE kind='run_failure' ORDER BY rowid DESC LIMIT 1")
    .get() as { body: string } | undefined;
  if (!row) throw new Error("No run_failure audit record");
  return (JSON.parse(row.body) as { fault: WorkerFault }).fault;
}
function runError(store: Store): string {
  return (
    store.db
      .prepare("SELECT error FROM runs WHERE agent_id='research' ORDER BY rowid DESC LIMIT 1")
      .get() as { error: string }
  ).error;
}
/** The baseline transcript a real run always starts from; the worker needs a trailing user turn. */
const baseline = (): AgentMessage[] => [
  createInitialSystemMessage("synthetic", [toolDefinition])!,
  { role: "user", content: "durable inbox delivery reference", timestamp: 0 },
];

it("distinguishes a transient model failure from a credential problem across a real worker process", async () => {
  const observed: Record<string, { fault: WorkerFault; retry: string }> = {};
  for (const scenario of ["transient", "credential"] as const) {
    const { store, collaboration: c, supervisor, work } = setup(scenario);
    c.enqueue("research", work, `one-${scenario}`, {});
    await supervisor.step("research");
    observed[scenario] = {
      fault: recordedFault(store),
      retry: retryDisposition(recordedFault(store)),
    };
  }
  expect(observed.transient!.fault).toMatchObject({ stage: "model", category: "transient_model" });
  expect(observed.credential!.fault).toMatchObject({
    stage: "model",
    category: "credential_config",
  });
  expect(observed.transient!.retry).toBe("retry_backoff");
  expect(observed.credential!.retry).toBe("human_action");
}, 30000);

it("keeps credentials and unfiltered third-party exception text out of caller-visible diagnostics", async () => {
  const { store, collaboration: c, supervisor, work } = setup("credential");
  c.enqueue("research", work, "one", {});
  await supervisor.step("research");
  const diagnostic = JSON.stringify(recordedFault(store)) + runError(store);
  expect(diagnostic).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz012345");
  expect(diagnostic).not.toContain("SyntheticProviderError");
  expect(diagnostic).not.toMatch(/\bat (?:async )?\S+ \(/);
  expect(recordedFault(store).reason.trim().length).toBeGreaterThan(0);
}, 20000);

it("a caller-side refusal reaches the worker as a definite refusal, not as a fault or an unknown effect", async () => {
  const worker = new WorkerClient(faultModel.provider, faultModel.id, "key", fixture, {
    MATE_FAULT_SCENARIO: "refused",
  });
  try {
    const journaled: unknown[] = [];
    // The caller-side text is hostile on purpose: only the filtered reason may cross the boundary.
    const refusalMessage = `Operation not permitted for this work item; try again after fixing it: ${"detail ".repeat(40)} sk-live-abcdefghijklmnopqrstuvwxyz012345`;
    const result = await worker.run(
      { sessionId: "s", messages: baseline(), recovery: "", maxTurns: 2 },
      {
        journal: async (message) => void journaled.push(message),
        tool: async () => {
          throw refusal(refusalMessage);
        },
      },
      10000,
      new AbortController().signal,
    );
    expect(result.certain).toBe(true);
    const toolResult = journaled.find(
      (message) => (message as { role?: string }).role === "toolResult",
    ) as { content: Array<{ text?: string }> } | undefined;
    // The model adjusts on this result, so the refusal and its filtered text have to survive the
    // caller-to-worker direction of the protocol. Only the bounded, filtered reason crosses.
    const text = toolResult?.content[0]?.text ?? "";
    expect(text).toContain("Operation not permitted for this work item");
    expect(text.length).toBeLessThanOrEqual(200);
    const serialized = JSON.stringify(journaled);
    expect(serialized).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz012345");
  } finally {
    worker.close();
  }
}, 20000);

it("marks an error thrown after an effect may have started as an unknown external effect", async () => {
  const { store, collaboration: c, router, work } = setup("none");
  c.enqueue("research", work, "effect", {});
  const run = store.beginRun("research")!;
  store.input(run, {});
  const failingBroker = new Broker(
    store,
    c,
    {
      execute: async () => {
        throw Object.assign(new Error("remote command connection reset"), { code: "ECONNRESET" });
      },
    } as never,
    { research: "/tmp" },
  );
  const failing = new ToolRouter(c, failingBroker);
  const categories: (FaultCategory | undefined)[] = [];
  // A valid operation that reaches the backend and fails there: the action was started, so its
  // external effect cannot be assumed absent.
  await failing
    .call(run, work, "exec", "exec", { command: "true", cwd: "." }, new AbortController().signal)
    .catch((error: unknown) => categories.push(faultOf(error)?.category));
  await failingBroker
    .execute(
      run,
      work,
      "write-effect",
      { kind: "write", path: ".", content: "x" },
      new AbortController().signal,
    )
    .catch((error: unknown) => categories.push(faultOf(error)?.category));
  // A refusal decided before any effect is a different class from the unknown effect above.
  await expect(
    router.call(run, work, "missing", "missing.operation", {}, new AbortController().signal),
  ).rejects.toSatisfy((error: unknown) => faultOf(error)?.category === "definite_tool_refusal");
  expect(categories).toEqual(["unknown_effect", "unknown_effect"]);
  // Both started actions are durably recorded as unknown rather than reported as never run. The
  // router prefixes its call id with the session; this direct broker call uses the id as given.
  expect(store.action(`${run.sessionId}:exec`)?.state).toBe("unknown");
  expect(store.action("write-effect")?.state).toBe("unknown");
}, 20000);

it("keeps a shared-persistence failure distinguishable after crossing the worker boundary", async () => {
  const {
    store,
    collaboration: c,
    supervisor,
    work,
  } = setup("persistence", async () => {
    throw Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" });
  });
  c.enqueue("research", work, "one", {});
  await supervisor.step("research");
  const fault = recordedFault(store);
  expect(fault).toMatchObject({ stage: "persistence", category: "shared_persistence" });
  expect(retryDisposition(fault)).toBe("no_retry");
  expect(fault.reason).toContain("durable record");
}, 20000);
