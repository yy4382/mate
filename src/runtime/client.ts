import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EngineHooks, EngineResult, RunSpec } from "./engine.js";
import {
  abortFault,
  classifyRpcStage,
  faultError,
  protocolFault,
  toWorkerFault,
  transientFault,
  workerFaultSchema,
  type WorkerFault,
} from "./fault.js";
const rpcSchema = z
  .object({
    type: z.literal("rpc"),
    nonce: z.string(),
    id: z.number().int().positive(),
    kind: z.enum([
      "journal",
      "tool",
      "notice",
      "invalidateViews",
      "refreshRecovery",
      "usageBegin",
      "usageComplete",
    ]),
    payload: z.unknown(),
  })
  .strict();
const resultSchema = z
  .object({
    tokens: z.number().int().nonnegative(),
    cost: z.number().finite().nonnegative(),
    certain: z.boolean(),
    waiting: z.boolean(),
    continuation: z.boolean(),
    snapshot: z.array(z.unknown()).optional(),
  })
  .strict();
export class WorkerClient {
  readonly child: ChildProcess;
  private active?: { nonce: string; reject(error: Error): void };
  /**
   * `workerEnv` is the synthetic-scenario hook for tests, alongside `entry`. The fixed identity
   * and provider variables are applied after it, so a caller can add fixture inputs but cannot
   * redirect which model, credential or entry mode the child runs with.
   */
  constructor(
    provider: string,
    model: string,
    key: string,
    entry = new URL("./worker.js", import.meta.url),
    workerEnv: Readonly<Record<string, string>> = {},
  ) {
    this.child = fork(entry, [], {
      env: {
        ...workerEnv,
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        MATE_WORKER: "1",
        MATE_PROVIDER: provider,
        MATE_MODEL: model,
        MATE_MODEL_KEY: key,
      },
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    this.child.on("error", (error) =>
      this.active?.reject(faultError(protocolFault(error.message))),
    );
    this.child.on("exit", () =>
      this.active?.reject(
        faultError(protocolFault("worker exited; usage and unfinished effects are uncertain")),
      ),
    );
  }
  async run(
    spec: RunSpec,
    hooks: EngineHooks,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<EngineResult> {
    if (this.active || !this.child.connected) throw faultError(protocolFault("worker unavailable"));
    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false,
        busy = false,
        sequence = 0;
      const finish = (error?: Error, result?: EngineResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.child.off("message", onMessage);
        delete this.active;
        if (error) {
          this.child.kill("SIGKILL");
          reject(error);
        } else resolve(result!);
      };
      const fail = (fault: WorkerFault) => finish(faultError(fault));
      const onAbort = () => fail(abortFault("the run was aborted before the worker finished"));
      // A worker that never answers is the transient case ticket #46 must back off and retry.
      const timer = setTimeout(
        () => fail(transientFault("the worker did not answer within the run timeout")),
        timeoutMs,
      );
      this.active = { nonce, reject: (error) => finish(error) };
      const onMessage = async (raw: unknown) => {
        if (Buffer.byteLength(JSON.stringify(raw)) > 2_000_000) {
          fail(protocolFault("oversize worker message"));
          return;
        }
        const envelope = raw as {
          nonce?: string;
          type?: string;
          result?: unknown;
          fault?: unknown;
        };
        if (envelope.nonce !== nonce || settled) return;
        if (envelope.type === "failed") {
          // The worker classified the failure at the stage it owns; keep that class rather than
          // reconstructing one from the text it also sends for compatibility.
          const fault = workerFaultSchema.safeParse(envelope.fault);
          if (fault.success) finish(faultError(fault.data));
          else fail(protocolFault("the worker reported an unreadable failure"));
          return;
        }
        if (envelope.type === "done") {
          const parsed = resultSchema.safeParse(envelope.result);
          if (!parsed.success || busy) fail(protocolFault("invalid worker completion"));
          else finish(undefined, parsed.data as EngineResult);
          return;
        }
        const parsed = rpcSchema.safeParse(raw);
        if (!parsed.success || busy || parsed.data.id <= sequence) {
          fail(protocolFault("invalid worker RPC"));
          return;
        }
        busy = true;
        const call = parsed.data;
        sequence = call.id;
        try {
          let value: unknown;
          if (call.kind === "refreshRecovery")
            value = z
              .string()
              .max(50000)
              .parse((await hooks.refreshRecovery?.()) ?? spec.recovery);
          else if (call.kind === "invalidateViews") await hooks.invalidateViews?.();
          else if (call.kind === "notice") value = await hooks.notice?.();
          else if (call.kind === "journal") {
            const msg = z
              .object({ role: z.enum(["system", "user", "assistant", "toolResult"]) })
              .passthrough()
              .parse(call.payload);
            await hooks.journal(msg as AgentMessage);
          } else if (call.kind === "usageBegin") {
            const begin = z
              .object({
                callIndex: z.number().int().positive(),
                provider: z.string().min(1),
                modelId: z.string().min(1),
              })
              .strict()
              .parse(call.payload);
            await hooks.usageBegin?.(begin.callIndex, begin.provider, begin.modelId);
          } else if (call.kind === "usageComplete") {
            const completed = z
              .object({
                callIndex: z.number().int().positive(),
                message: z
                  .object({ role: z.literal("assistant"), usage: z.unknown() })
                  .passthrough(),
              })
              .strict()
              .parse(call.payload);
            value = await hooks.usageComplete?.(
              completed.callIndex,
              completed.message as unknown as AssistantMessage,
            );
          } else {
            const tool = z
              .object({
                id: z.string().min(1).max(500),
                operation: z.string().max(100),
                args: z.unknown(),
              })
              .strict()
              .parse(call.payload);
            value = await hooks.tool(tool.id, tool.operation, tool.args);
          }
          if (!settled) this.child.send({ type: "reply", nonce, id: call.id, value });
        } catch (error) {
          // Classify the failure on the side that owns the operation. The worker receives the
          // shared shape, so a refusal stays a refusal and a durable-write failure stays a
          // persistence failure instead of both arriving as one opaque string.
          const fault = toWorkerFault(error, classifyRpcStage(call.kind));
          if (!settled) this.child.send({ type: "reply", nonce, id: call.id, fault });
        } finally {
          busy = false;
        }
      };
      this.child.on("message", onMessage);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      else this.child.send({ type: "run", nonce, spec });
    });
  }
  close(): void {
    this.active?.reject(faultError(protocolFault("worker closed before the run finished")));
    this.child.kill("SIGKILL");
  }
}
