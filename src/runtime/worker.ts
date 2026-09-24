import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { normalizeContext, type Models } from "@earendil-works/pi-ai";
import {
  generateSummaryWithUsage,
  type AgentMessage,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core/harness/context";
import { z } from "zod";
import { Engine, type RunSpec, type ToolReply } from "./engine.js";
import {
  abortFault,
  workerCredentialFault,
  faultError,
  protocolFault,
  toWorkerFault,
  workerFaultSchema,
  type WorkerFault,
} from "./fault.js";

/** A malformed reply fault is still a failure: never fall back to trusting the raw payload. */
function parseFault(raw: unknown): WorkerFault {
  const parsed = workerFaultSchema.safeParse(raw);
  return parsed.success ? parsed.data : protocolFault("the caller reported a malformed failure");
}

export async function summarizeWithPi(
  models: Models,
  engine: Engine,
  messages: AgentMessage[],
  stream: StreamFn,
  signal: AbortSignal,
): Promise<string> {
  const bounded: Models = {
    ...models,
    completeSimple: async (model, context, options) =>
      (await stream(model, normalizeContext(context), { ...options, signal })).result(),
  };
  const summary = await generateSummaryWithUsage(
    messages,
    bounded,
    engine.model,
    2000,
    undefined,
    undefined,
    "off",
    { enabled: false, maxRetries: 0, baseDelayMs: 0 },
    undefined,
    withAbortSignal(signal, BACKGROUND_CONTEXT),
  );
  if (!summary.ok) throw new Error("Compaction failed");
  return summary.value.text;
}
const startSchema = z.object({
  type: z.literal("run"),
  nonce: z.string(),
  spec: z.object({
    sessionId: z.string(),
    messages: z.array(z.unknown()),
    recovery: z.string().max(50000),
    maxTurns: z.number().int().min(1).max(20),
  }),
});
/** The worker end of the protocol: failures leave as one shared fault shape, not as strings. */
export function serveWorker(engine: Engine, models?: Models, startupFault?: WorkerFault): void {
  let nonce: string | undefined,
    counter = 0,
    active = false;
  // A failure that happened before any run existed (an unusable credential, an unresolvable
  // model) has no run to name. It is held here and reported to the first run the caller starts,
  // because an unsolicited envelope carrying no nonce is dropped by the caller by design.
  let pendingStartup: WorkerFault | undefined = startupFault;
  let abort = new AbortController();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  function fail(
    message: string,
    error: unknown,
    stage: Parameters<typeof toWorkerFault>[1],
    failedNonce: string | undefined = nonce,
  ): void {
    const fault: WorkerFault = toWorkerFault(error, stage, { reason: message });
    process.send?.({ type: "failed", nonce: failedNonce, fault });
  }
  function rpc(kind: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++counter;
      pending.set(id, { resolve, reject });
      process.send?.({ type: "rpc", nonce, id, kind, payload });
    });
  }
  const stop = () => {
    abort.abort();
    engine.abort();
    // A disconnect or abort stops the run; it says nothing about the durable store.
    for (const waiter of pending.values())
      waiter.reject(faultError(abortFault("the caller disconnected or aborted the run")));
    pending.clear();
  };
  process.on("disconnect", () => {
    stop();
    process.exit(0);
  });
  process.on("message", async (raw) => {
    const message = raw as {
      type?: string;
      nonce?: string;
      id?: number;
      fault?: unknown;
      value?: unknown;
    };
    if (message.type === "abort" && message.nonce === nonce) {
      stop();
      return;
    }
    if (message.type === "reply" && message.nonce === nonce && message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      // The caller classified its own failure; keep that class instead of re-deriving it from
      // text that has already crossed the boundary.
      if (message.fault !== undefined) waiter?.reject(faultError(parseFault(message.fault)));
      else waiter?.resolve(message.value);
      return;
    }
    const parsed = startSchema.safeParse(raw);
    if (!parsed.success) {
      // A rejected payload still names the run it refused, so the caller fails that run now
      // instead of waiting for its timeout.
      if (message.type === "run") fail("Invalid worker run payload", null, "worker", message.nonce);
      return;
    }
    if (active) {
      fail("Worker already active", null, "worker", message.nonce);
      return;
    }
    if (pendingStartup) {
      // This worker cannot serve any run. Report why against the run the caller just started.
      const fault = pendingStartup;
      pendingStartup = undefined;
      process.send?.({ type: "failed", nonce: message.nonce, fault });
      return;
    }
    active = true;
    nonce = parsed.data.nonce;
    abort = new AbortController();
    try {
      const result = await engine.run(parsed.data.spec as RunSpec, {
        refreshRecovery: async () =>
          z
            .string()
            .max(50000)
            .parse(await rpc("refreshRecovery", null)),
        invalidateViews: async () => {
          await rpc("invalidateViews", null);
        },
        notice: async () => (await rpc("notice", null)) as string | undefined,
        journal: async (message) => {
          await rpc("journal", message);
        },
        usageBegin: async (callIndex, provider, modelId) => {
          await rpc("usageBegin", { callIndex, provider, modelId });
        },
        usageComplete: async (callIndex, message) =>
          (await rpc("usageComplete", { callIndex, message })) as boolean | undefined,
        tool: async (id, operation, args) =>
          (await rpc("tool", { id, operation, args })) as ToolReply,
        ...(models
          ? {
              summarize: async (messages, stream) =>
                summarizeWithPi(models, engine, messages, stream, abort.signal),
            }
          : {}),
      });
      process.send?.({ type: "done", nonce, result });
    } catch (error) {
      fail("The worker run failed", error, "worker");
    } finally {
      active = false;
    }
  });
}
if (process.env.MATE_WORKER === "1") {
  const models = builtinModels();
  const model = models.getModel(process.env.MATE_PROVIDER!, process.env.MATE_MODEL!);
  // An unusable credential is a configuration problem a human must fix, never a transient one.
  // `serveWorker` refuses every run while a startup fault is pending, so the engine it is handed
  // here is never used; a worker without a model has nothing to build one with.
  const startupFault = !model
    ? workerCredentialFault("the configured model is unknown to this worker")
    : process.env.MATE_MODEL_KEY
      ? undefined
      : workerCredentialFault("the worker has no model credential");
  serveWorker(
    model
      ? new Engine(model, (m, context, options) =>
          models.streamSimple(m, context, {
            ...options,
            apiKey: process.env.MATE_MODEL_KEY!,
            env: {},
          }),
        )
      : ({} as Engine),
    models,
    startupFault,
  );
}
