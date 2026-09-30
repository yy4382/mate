import { inputMessage, assistantText } from "../helpers/session.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runAgentModel } from "../../src/nodes/agent-runner.js";
import { NodeControlMessageSchema } from "@mate/protocol";

interface WorkerAccountProbe {
  pid: number;
  uid: number | null;
  gid: number | null;
  execPath: string;
  argv: string[];
  groups: number[] | null;
}

const probeEntry = resolve("tests/fixtures/account-probe-model-worker.mjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** The node's own run request for one synthetic Agent turn. */
function agentRunRequest(role = "验证") {
  const message = NodeControlMessageSchema.parse({
    type: "control.agent.run",
    requestId: randomUUID(),
    runId: randomUUID(),
    agentId: randomUUID(),
    sessionId: randomUUID(),
    actionScopeId: randomUUID(),
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKey: "synthetic-key-single-account-probe",
    channelId: randomUUID(),
    channelVisibility: "private",
    prompt: { name: "小林", role, description: "Synthetic test Agent" },
  });
  if (message.type !== "control.agent.run") throw new Error("Unexpected control message");
  return message;
}

/** Drive one run through the node's Agent run path and capture the worker's own account report. */
function runProbe(request: ReturnType<typeof agentRunRequest>) {
  let probe: WorkerAccountProbe | undefined;
  const controller = new AbortController(),
    results: Array<{ ok: boolean; code?: string }> = [];
  const run = runAgentModel(
    structuredClone(request),
    {
      context: async () => ({
        messages: [inputMessage("报告启动本次运行的 Linux 账号。", request.channelId, "private")],
        nextCursor: null,
      }),
      transcript: async (entry) => {
        const text = assistantText(entry);
        if (text === undefined) return true;
        probe = JSON.parse(text) as WorkerAccountProbe;
        return true;
      },
      tool: async () => ({ ok: false, error: "No Agent tool transport is available" }),
      result: (ok, code) => results.push({ ok, ...(code ? { code } : {}) }),
    },
    controller.signal,
    { modelWorkerEntry: probeEntry },
  );
  return { run, controller, results, probe: () => probe };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`Model worker ${pid} was still alive after the run ended`);
}

function filesContain(directory: string, token: string): boolean {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && filesContain(path, token)) return true;
    if (entry.isFile() && readFileSync(path).includes(token)) return true;
  }
  return false;
}

it("runs the short-lived model worker as the launching account and releases it", async () => {
  const homeRoot = mkdtempSync(join(tmpdir(), "mate-agent-home-"));
  roots.push(homeRoot);
  mkdirSync(join(homeRoot, "workspace"), { recursive: true });

  const probeRun = runProbe(agentRunRequest());
  await probeRun.run;
  const probe = probeRun.probe();

  expect(probe).toBeDefined();
  expect(probeRun.results).toEqual([{ ok: true }]);
  expect(probe!.execPath).toBe(process.execPath);
  expect(probe!.argv.slice(0, 2)).toEqual([process.execPath, probeEntry]);
  if (typeof process.getuid === "function") expect(probe!.uid).toBe(process.getuid());
  if (typeof process.getgid === "function") expect(probe!.gid).toBe(process.getgid());
  if (typeof process.getgroups === "function") expect(probe!.groups).toEqual(process.getgroups());

  // The credential-bearing child is short-lived and never writes its key anywhere on disk.
  await waitForExit(probe!.pid);
  expect(filesContain(homeRoot, "synthetic-key-single-account-probe")).toBe(false);
});

it("releases the model worker when its run is cancelled", async () => {
  const probeRun = runProbe(agentRunRequest("保持运行"));
  const deadline = Date.now() + 5000;
  while (!probeRun.probe() && Date.now() < deadline)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  expect(probeRun.probe()).toBeDefined();

  probeRun.controller.abort();
  await expect(probeRun.run).resolves.toBeUndefined();
  // A cancelled run reports no result; the control plane owns cancellation through its own path.
  expect(probeRun.results).toEqual([]);
  await waitForExit(probeRun.probe()!.pid);
});
