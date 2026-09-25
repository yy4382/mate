import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ModelRunSpec } from "./model-worker.js";

const journalMessageSchema = z
  .object({
    type: z.literal("journal"),
    nonce: z.string().uuid(),
    requestId: z.string().uuid(),
    text: z.string().min(1).max(20_000),
  })
  .strict();
const workerResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("done"), nonce: z.string().uuid() }).strict(),
  z
    .object({
      type: z.literal("failed"),
      nonce: z.string().uuid().optional(),
      code: z.enum(["model_unavailable", "model_failed", "worker_failed"]),
    })
    .strict(),
]);
const journalAckSchema = z
  .object({
    type: z.literal("journal_ack"),
    nonce: z.string().uuid(),
    requestId: z.string().uuid(),
    accepted: z.boolean(),
  })
  .strict();

export interface ModelProcessIdentity {
  uid: number;
  gid: number;
}

export interface ModelProcessOptions {
  provider: string;
  modelId: string;
  apiKey: string;
  entry?: string;
  identity?: ModelProcessIdentity;
  onJournal(text: string): Promise<boolean>;
  signal: AbortSignal;
}

export interface ModelProcessSession {
  run(spec: ModelRunSpec): Promise<void>;
  close(): void;
}

/** Start one credential-bearing Pi model loop in a short-lived child process. */
export function startModelProcess(options: ModelProcessOptions): ModelProcessSession {
  const { provider, modelId, entry, identity, onJournal, signal } = options;
  let apiKey = options.apiKey;
  const nonce = randomUUID(),
    env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      MATE_MODEL_WORKER: "1",
      MATE_MODEL_PROVIDER: provider,
      MATE_MODEL_ID: modelId,
      MATE_MODEL_KEY: apiKey,
    },
    child = fork(entry ?? fileURLToPath(new URL("./model-worker.js", import.meta.url)), [], {
      ...(identity
        ? {
            execPath: "/usr/bin/setpriv",
            execArgv: [
              "--reuid",
              String(identity.uid),
              "--regid",
              String(identity.gid),
              "--clear-groups",
              "--",
              process.execPath,
            ],
          }
        : { execArgv: [] }),
      env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
  apiKey = "";
  delete env.MATE_MODEL_KEY;
  let active = false;
  const abortChild = () => child.kill("SIGKILL");
  signal.addEventListener("abort", abortChild, { once: true });
  return {
    run(spec) {
      if (active) return Promise.reject(new Error("Agent model process already ran"));
      active = true;
      return waitForModelProcess(child, nonce, spec, { onJournal, signal }).finally(() => {
        signal.removeEventListener("abort", abortChild);
      });
    },
    close() {
      signal.removeEventListener("abort", abortChild);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

function waitForModelProcess(
  child: ChildProcess,
  nonce: string,
  spec: ModelRunSpec,
  hooks: Pick<ModelProcessOptions, "onJournal" | "signal">,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false,
      journalBusy = false;
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
      const journal = journalMessageSchema.safeParse(raw);
      if (journal.success && journal.data.nonce === nonce) {
        if (journalBusy) return fail("Agent model worker sent overlapping journal requests");
        journalBusy = true;
        let accepted = false;
        try {
          accepted = await hooks.onJournal(journal.data.text);
        } catch {
          accepted = false;
        }
        if (!settled && child.connected)
          child.send({
            type: "journal_ack",
            nonce,
            requestId: journal.data.requestId,
            accepted,
          });
        journalBusy = false;
        if (!accepted) fail("Control plane rejected the Agent session journal");
        return;
      }
      const result = workerResultSchema.safeParse(raw);
      if (!result.success || ("nonce" in result.data && result.data.nonce !== nonce))
        return fail("Agent model worker sent an invalid response");
      if (result.data.type === "done") finish();
      else fail("Agent model run failed");
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

export const modelWorkerJournalAckSchema = journalAckSchema;
