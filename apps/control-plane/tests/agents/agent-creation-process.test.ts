import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  ownerPassword,
  login,
  startControlPlane,
  startNode,
  stopProcess,
  type ProcessOutput,
} from "../support/environment/run-services.js";
interface AgentPayload {
  id: string;
  name: string;
  role: string;
  description: string;
  model: { provider: string; id: string };
}

function agentPayload(overrides: Partial<AgentPayload> = {}): AgentPayload {
  return {
    id: randomUUID(),
    name: "研究与写作同事",
    role: "处理被指派的私信任务",
    description: "Synthetic single-account Agent creation fixture.",
    model: { provider: "openai", id: "gpt-4o-mini" },
    ...overrides,
  };
}

function createAgent(
  origin: string,
  cookie: string,
  nodeId: string,
  payload: AgentPayload,
): Promise<Response> {
  return fetch(new URL("/api/owner/agents", origin), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ ...payload, nodeId }),
  });
}

it("shows a diagnosable failure on the web when the node cannot prepare the workspace", async () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-creation-failure-"));
  const nodeData = join(directory, "node-data");
  const readonlyRoot = join(directory, "read-only-workspaces");
  chmodSync(directory, 0o700);
  mkdirSync(readonlyRoot, { mode: 0o500 });
  chmodSync(readonlyRoot, 0o500);
  writeFileSync(join(directory, "owner-password"), `${ownerPassword}\n`, { mode: 0o600 });

  let control: ProcessOutput | undefined;
  let node: ProcessOutput | undefined;
  try {
    control = startControlPlane(directory);
    const origin = `http://127.0.0.1:${(await control.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/))[1]}`;
    const cookie = await login(origin);
    const pairing = await fetch(new URL("/api/owner/nodes/pairing-tokens", origin), {
      method: "POST",
      headers: { cookie },
    });
    const { pairingToken } = (await pairing.json()) as { pairingToken: string };

    node = startNode({
      origin,
      nodeData,
      workspaceRoot: readonlyRoot,
      pairingToken,
    });
    const paired = await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i);

    const payload = agentPayload();
    const response = await createAgent(origin, cookie, paired[1]!, payload);
    expect(response.status).toBe(502);
    const failed = (await response.json()) as {
      error: string;
      agent: { id: string; status: string; error: string | null };
    };
    expect(failed.agent.id).toBe(payload.id);
    expect(failed.agent.status).toBe("failed");
    // The owner sees what to fix, and the banner text stays ordinary language.
    expect(failed.error).toContain("工作区");
    expect(failed.error).not.toContain("root");
    // Nothing was half-created: no workspace directory and no other Agent.
    const listed = (await (
      await fetch(new URL("/api/owner/agents", origin), { headers: { cookie } })
    ).json()) as { agents: Array<{ id: string; status: string; error: string | null }> };
    expect(listed.agents).toHaveLength(1);
    expect(listed.agents[0]).toMatchObject({ id: payload.id, status: "failed" });
    expect(listed.agents[0]!.error).toContain("工作区");
    expect(existsSync(join(readonlyRoot, payload.id))).toBe(false);
  } finally {
    if (node) await stopProcess(node);
    if (control) await stopProcess(control);
    chmodSync(readonlyRoot, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
