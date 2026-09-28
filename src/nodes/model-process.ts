import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { sessionCommitSchema, type SessionCommit } from "./session-record.js";
import type { ModelRunSpec } from "./model-worker.js";

const transcriptMessageSchema = z
  .object({
    type: z.literal("transcript"),
    nonce: z.string().uuid(),
    requestId: z.string().uuid(),
    entry: sessionCommitSchema,
  })
  .strict();
const workerResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("done"), nonce: z.string().uuid() }).strict(),
  z
    .object({
      type: z.literal("failed"),
      nonce: z.string().uuid().optional(),
      code: z.enum([
        "model_unavailable",
        "model_failed",
        "worker_failed",
        "credentials_invalid",
        "context_failed",
      ]),
    })
    .strict(),
]);
const transcriptAckSchema = z
  .object({
    type: z.literal("transcript_ack"),
    nonce: z.string().uuid(),
    requestId: z.string().uuid(),
    accepted: z.boolean(),
  })
  .strict();
const toolMessageSchema = z
  .object({
    type: z.literal("tool"),
    nonce: z.string().uuid(),
    requestId: z.string().uuid(),
    toolCallId: z.string().min(1).max(500),
    operation: z.string().min(1).max(128),
    input: z.record(z.string(), z.json()),
  })
  .strict();
const toolResultSchema = z.discriminatedUnion("ok", [
  z
    .object({
      type: z.literal("tool_result"),
      nonce: z.string().uuid(),
      requestId: z.string().uuid(),
      toolCallId: z.string().min(1).max(500),
      ok: z.literal(true),
      result: z.json(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_result"),
      nonce: z.string().uuid(),
      requestId: z.string().uuid(),
      toolCallId: z.string().min(1).max(500),
      ok: z.literal(false),
      error: z.string().min(1).max(240),
    })
    .strict(),
]);

export type ModelToolResult = z.infer<typeof toolResultSchema>;

export interface ModelProcessOptions {
  provider: string;
  modelId: string;
  apiKey: string;
  entry?: string;
  /** Records one complete Pi message or run configuration in the Agent session record; never publishes. */
  onTranscript(entry: SessionCommit): Promise<boolean>;
  onTool?(
    toolCallId: string,
    operation: string,
    input: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
  signal: AbortSignal;
}

export interface ModelProcessSession {
  run(spec: ModelRunSpec): Promise<void>;
  /**
   * Hand the running loop one content-free "another message arrived" notice. Returns false when
   * this session has no run in progress, so a caller cannot revive a settled or aborted run.
   */
  notice(conversationId: string): boolean;
  close(): void;
}

/** Start one credential-bearing Pi model loop in a short-lived child process. */
export function startModelProcess(options: ModelProcessOptions): ModelProcessSession {
  const { provider, modelId, entry, onTranscript, onTool, signal } = options;
  let apiKey = options.apiKey;
  const nonce = randomUUID(),
    env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      MATE_MODEL_WORKER: "1",
      MATE_MODEL_PROVIDER: provider,
      MATE_MODEL_ID: modelId,
      MATE_MODEL_KEY: apiKey,
      ...(entry ? { MATE_MODEL_TEST_DIAGNOSTICS: "1" } : {}),
    },
    // The worker inherits the launching account so credentials never need a separate Linux identity.
    child = fork(entry ?? fileURLToPath(new URL("./model-worker.js", import.meta.url)), [], {
      execArgv: [],
      env,
      stdio: ["ignore", "ignore", entry ? "inherit" : "ignore", "ipc"],
      serialization: "json",
    });
  apiKey = "";
  delete env.MATE_MODEL_KEY;
  // `active` is the one-run-per-process latch; `settled` separates "not started yet" (where a
  // notice is still worth keeping) from "already over" (where a late notice must change nothing).
  let active = false,
    running = false,
    settled = false;
  /** Notices that arrived while this run was still starting, delivered with the run itself. */
  const pendingNotices: string[] = [];
  const sendNotice = (conversationId: string): boolean => {
    if (!running || !child.connected || child.exitCode !== null || child.signalCode !== null)
      return false;
    try {
      child.send({ type: "notice", nonce, conversationId });
      return true;
    } catch {
      return false;
    }
  };
  const abortChild = () => child.kill("SIGKILL");
  signal.addEventListener("abort", abortChild, { once: true });
  return {
    run(spec) {
      if (active) return Promise.reject(new Error("Agent model process already ran"));
      active = true;
      running = true;
      // The run spec reaches the child synchronously, so the loop always sees the run first.
      const completion = waitForModelProcess(child, nonce, spec, {
        onTranscript,
        ...(onTool ? { onTool } : {}),
        signal,
      }).finally(() => {
        running = false;
        settled = true;
        pendingNotices.length = 0;
        signal.removeEventListener("abort", abortChild);
      });
      for (const conversationId of pendingNotices.splice(0)) sendNotice(conversationId);
      return completion;
    },
    notice(conversationId) {
      if (running) return sendNotice(conversationId);
      if (settled || !child.connected) return false;
      pendingNotices.push(conversationId);
      return true;
    },
    close() {
      running = false;
      settled = true;
      pendingNotices.length = 0;
      signal.removeEventListener("abort", abortChild);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

export class ModelRunFailure extends Error {
  constructor(
    readonly code:
      | "model_unavailable"
      | "model_failed"
      | "worker_failed"
      | "credentials_invalid"
      | "context_failed",
  ) {
    super("Agent model run failed");
  }
}

function waitForModelProcess(
  child: ChildProcess,
  nonce: string,
  spec: ModelRunSpec,
  hooks: Pick<ModelProcessOptions, "onTranscript" | "onTool" | "signal">,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false,
      requestBusy = false;
    const fail = (message: string) => finish(new Error(message));
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      hooks.signal.removeEventListener("abort", onAbort);
      child.off("message", onMessage);
      if (child.connected) child.disconnect();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => fail("Agent model run aborted");
    const onMessage = async (raw: unknown) => {
      if (settled) return;
      const transcript = transcriptMessageSchema.safeParse(raw);
      if (transcript.success && transcript.data.nonce === nonce) {
        if (requestBusy) return fail("Agent model worker sent overlapping control requests");
        requestBusy = true;
        let accepted = false;
        try {
          accepted = await hooks.onTranscript(transcript.data.entry);
        } catch {
          accepted = false;
        }
        if (!settled && child.connected)
          child.send({
            type: "transcript_ack",
            nonce,
            requestId: transcript.data.requestId,
            accepted,
          });
        requestBusy = false;
        if (!accepted) fail("Control plane rejected the Agent run transcript");
        return;
      }
      const tool = toolMessageSchema.safeParse(raw);
      if (tool.success && tool.data.nonce === nonce) {
        if (requestBusy) return fail("Agent model worker sent overlapping control requests");
        requestBusy = true;
        let result: { ok: true; result: unknown } | { ok: false; error: string } = {
          ok: false,
          error: "Control plane rejected the Agent tool call",
        };
        try {
          result = hooks.onTool
            ? await hooks.onTool(tool.data.toolCallId, tool.data.operation, tool.data.input)
            : { ok: false, error: "No Agent tool transport is available" };
        } catch {
          result = { ok: false, error: "Control plane could not complete the Agent tool call" };
        }
        const safeResult = toolResultSchema.safeParse({
          type: "tool_result",
          nonce,
          requestId: tool.data.requestId,
          toolCallId: tool.data.toolCallId,
          ...result,
        });
        if (!safeResult.success) return fail("Control plane returned an invalid Agent tool result");
        if (!settled && child.connected) child.send(safeResult.data);
        requestBusy = false;
        return;
      }
      const result = workerResultSchema.safeParse(raw);
      if (!result.success || ("nonce" in result.data && result.data.nonce !== nonce))
        return fail("Agent model worker sent an invalid response");
      if (result.data.type === "done") finish();
      else finish(new ModelRunFailure(result.data.code));
    };
    hooks.signal.addEventListener("abort", onAbort, { once: true });
    child.on("message", onMessage);
    child.once("error", () => fail("Agent model worker could not start"));
    child.once("exit", () => {
      if (!settled) fail("Agent model worker exited before completing the run");
    });
    if (hooks.signal.aborted) {
      onAbort();
      return;
    }
    child.send({ type: "run", nonce, spec });
  });
}
