import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// One owner, one ordinary account, two Agents created from the web, and the owner's read-only
// workspace preview in front of the real node file helper. The preview belongs to the selected
// Agent: neither a path nor a symbolic link may make it show another Agent's files, and both
// workspaces with their memory entry points survive a restart.
const ownerPassword = "agent-workspace-boundary-owner-password";

class ProcessOutput {
  text = "";
  exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly changes = new Set<() => void>();
  readonly exited: Promise<void>;

  constructor(readonly child: ChildProcess) {
    if (!child.stdout || !child.stderr)
      throw new Error("Test child process output was unavailable");
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => this.append(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => this.append(chunk));
    this.exited = new Promise((resolveExit) => {
      child.once("exit", (code, signal) => {
        this.exitStatus = { code, signal };
        this.changed();
        resolveExit();
      });
    });
  }

  waitFor(pattern: RegExp, timeoutMs = 20_000): Promise<RegExpMatchArray> {
    const current = this.text.match(pattern);
    if (current) return Promise.resolve(current);
    return new Promise((resolveMatch, reject) => {
      const finish = (match?: RegExpMatchArray) => {
        clearTimeout(timeout);
        this.changes.delete(check);
        if (match) resolveMatch(match);
        else reject(new Error(`Test process did not produce ${pattern}`));
      };
      const check = () => {
        const match = this.text.match(pattern);
        if (match) finish(match);
        else if (this.exitStatus) finish();
      };
      const timeout = setTimeout(() => finish(), timeoutMs);
      this.changes.add(check);
    });
  }

  private append(chunk: string): void {
    this.text += chunk;
    this.changed();
  }

  private changed(): void {
    for (const change of [...this.changes]) change();
  }
}

async function stopProcess(output: ProcessOutput): Promise<void> {
  if (output.exitStatus) return;
  output.child.kill("SIGTERM");
  await Promise.race([
    output.exited,
    new Promise<void>((resolveStop) =>
      setTimeout(() => {
        output.child.kill("SIGKILL");
        resolveStop();
      }, 2000),
    ),
  ]);
  await output.exited;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** The control plane keeps its address across a restart, so the still-running node reconnects. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    probe.once("error", rejectListen);
    probe.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = probe.address();
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port");
  return address.port;
}

function startControlPlane(directory: string, port: number): ProcessOutput {
  return new ProcessOutput(
    spawn(process.execPath, [resolve("dist/main.js")], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C.UTF-8",
        MATE_CONTROL_PLANE_PORT: String(port),
        MATE_CONTROL_PLANE_DATA_DIR: join(directory, "control-plane-data"),
        MATE_OWNER_PASSWORD_FILE: join(directory, "owner-password"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

/**
 * The production node entry with the real workspace executor injected explicitly, so the same real
 * file helper runs on every platform instead of only on Linux.
 */
function startNode(options: {
  origin: string;
  nodeData: string;
  workspaceRoot: string;
  pairingToken?: string;
}): ProcessOutput {
  const clientModule = import.meta.resolve("@mate/node"),
    executorModule = import.meta.resolve("@mate/node/workspace-execution"),
    runner = `
      const { runLinuxNodeWithTestDependencies } = await import(${JSON.stringify(clientModule)});
      const { LinuxWorkspaceExecutor } = await import(${JSON.stringify(executorModule)});
      const controller = new AbortController();
      process.on("SIGTERM", () => controller.abort());
      await runLinuxNodeWithTestDependencies({
        controlPlaneUrl: process.env.MATE_CONTROL_PLANE_URL,
        dataDirectory: process.env.MATE_NODE_DATA_DIR,
        agentWorkspaceRoot: process.env.MATE_NODE_AGENT_WORKSPACE_ROOT,
        pairingToken: process.env.MATE_NODE_PAIRING_TOKEN,
        heartbeatIntervalMs: 100,
        heartbeatTimeoutMs: 2000,
      }, controller.signal, {
        workspaceExecutor: new LinuxWorkspaceExecutor(
          process.env.MATE_NODE_AGENT_WORKSPACE_ROOT,
          process.env.MATE_NODE_DATA_DIR,
        ),
      });
    `;
  return new ProcessOutput(
    spawn(process.execPath, ["--input-type=module", "--eval", runner], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C.UTF-8",
        MATE_CONTROL_PLANE_URL: options.origin,
        MATE_NODE_DATA_DIR: options.nodeData,
        MATE_NODE_AGENT_WORKSPACE_ROOT: options.workspaceRoot,
        ...(options.pairingToken ? { MATE_NODE_PAIRING_TOKEN: options.pairingToken } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

async function login(origin: string): Promise<string> {
  const response = await fetch(new URL("/api/auth/login", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: ownerPassword }),
  });
  expect(response.status).toBe(204);
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

async function waitForNodeOnline(
  origin: string,
  cookie: string,
  nodeId: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("/api/owner/nodes", origin), { headers: { cookie } });
    if (response.ok) {
      const { nodes } = (await response.json()) as {
        nodes: Array<{ id: string; online: boolean }>;
      };
      if (nodes.some((entry) => entry.id === nodeId && entry.online)) return;
    }
    await delay(50);
  }
  throw new Error("Node did not come online");
}

interface CreatedAgent {
  id: string;
  sessionId: string;
  status: string;
  linuxIdentity: { username: string; uid: number; gid: number; workspace: string } | null;
}

async function createAgent(
  origin: string,
  cookie: string,
  nodeId: string,
  name: string,
): Promise<CreatedAgent> {
  const response = await fetch(new URL("/api/owner/agents", origin), {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      id: randomUUID(),
      nodeId,
      name,
      role: "维护自己的工作区",
      description: "Synthetic workspace boundary fixture.",
      model: { provider: "openai", id: "gpt-4o-mini" },
    }),
  });
  expect(response.status).toBe(201);
  const { agent } = (await response.json()) as { agent: CreatedAgent };
  expect(agent.linuxIdentity).not.toBeNull();
  return agent;
}

it("keeps the owner workspace preview inside the selected Agent through restarts", async () => {
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const directory = mkdtempSync(join(tmpdir(), "mate-agent-workspace-boundary-")),
    nodeData = join(directory, "node-data"),
    workspaceRoot = join(directory, "agent-workspaces"),
    port = await freePort(),
    origin = `http://127.0.0.1:${port}`;
  chmodSync(directory, 0o700);
  mkdirSync(workspaceRoot, { mode: 0o700 });
  mkdirSync(nodeData, { mode: 0o700 });
  writeFileSync(join(directory, "owner-password"), `${ownerPassword}\n`, { mode: 0o600 });

  let control: ProcessOutput | undefined, node: ProcessOutput | undefined;
  try {
    control = startControlPlane(directory, port);
    await control.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/);
    const cookie = await login(origin),
      pairing = await fetch(new URL("/api/owner/nodes/pairing-tokens", origin), {
        method: "POST",
        headers: { cookie },
      }),
      { pairingToken } = (await pairing.json()) as { pairingToken: string };
    node = startNode({ origin, nodeData, workspaceRoot, pairingToken });
    const paired = await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i),
      nodeId = paired[1]!;

    const first = await createAgent(origin, cookie, nodeId, "第一名同事"),
      second = await createAgent(origin, cookie, nodeId, "第二名同事"),
      firstWorkspace = first.linuxIdentity!.workspace,
      secondWorkspace = second.linuxIdentity!.workspace;
    expect(firstWorkspace).toBe(join(workspaceRoot, first.id));
    expect(secondWorkspace).toBe(join(workspaceRoot, second.id));
    expect(firstWorkspace).not.toBe(secondWorkspace);
    // The peer's file and a link that tries to reach it from inside the other workspace.
    writeFileSync(join(secondWorkspace, "peer-notes.md"), "peer notes\n", { mode: 0o600 });
    symlinkSync(join(secondWorkspace, "peer-notes.md"), join(firstWorkspace, "peer-link.md"));

    const preview = (agentId: string, path: string, route = ""): Promise<Response> =>
      fetch(
        new URL(
          `/api/owner/agents/${agentId}/workspace${route}?path=${encodeURIComponent(path)}`,
          origin,
        ),
        { headers: { cookie } },
      );

    // Browsing the selected Agent still works, by relative and by absolute path.
    const listing = await preview(first.id, "");
    expect(listing.status).toBe(200);
    const entries = ((await listing.json()) as { entries: Array<{ name: string; type: string }> })
      .entries;
    expect(entries).toContainEqual({ name: "MEMORY.md", type: "file", size: expect.any(Number) });
    expect(entries).toContainEqual({
      name: "peer-link.md",
      type: "symlink",
      size: expect.any(Number),
    });
    expect((await preview(first.id, "MEMORY.md", "/stat")).status).toBe(200);

    // Every route refuses to leave the selected workspace, by path or by symbolic link.
    for (const path of [
      `../${second.id}`,
      `../${second.id}/peer-notes.md`,
      join(secondWorkspace, "peer-notes.md"),
      "..",
      "../../etc/passwd",
      "/etc/passwd",
      "peer-link.md",
    ]) {
      for (const route of ["", "/stat", "/chunk"]) {
        const refused = await preview(first.id, path, route);
        expect(refused.status, `${route || "/"} must not preview ${path}`).toBe(403);
        expect(((await refused.json()) as { code: string }).code).toBe("unsafe_path");
      }
    }

    // A download is a stream of the same file, so it obeys the same boundary and records failure.
    const downloadId = randomUUID(),
      download = await fetch(
        new URL(
          `/api/owner/agents/${first.id}/workspace/download?path=${encodeURIComponent(`../${second.id}/peer-notes.md`)}&downloadId=${downloadId}`,
          origin,
        ),
        { headers: { cookie } },
      );
    expect(download.status).toBe(403);
    const status = await fetch(
      new URL(`/api/owner/agents/${first.id}/workspace/downloads/${downloadId}`, origin),
      { headers: { cookie } },
    );
    expect(await status.json()).toMatchObject({ state: "failed", errorCode: "unsafe_path" });

    // The restriction follows the selected Agent, not the file: the same preview pointed at the
    // second Agent shows the second Agent's own workspace.
    const peerPreview = await preview(second.id, "");
    expect(peerPreview.status).toBe(200);
    expect(
      ((await peerPreview.json()) as { entries: Array<{ name: string }> }).entries.map(
        (entry) => entry.name,
      ),
    ).toContain("peer-notes.md");

    // Restart both processes: the node re-adopts the workspaces from disk and the control plane
    // keeps the same Agents.
    await stopProcess(node);
    node = undefined;
    await stopProcess(control);
    control = undefined;
    control = startControlPlane(directory, port);
    await control.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/);
    node = startNode({ origin, nodeData, workspaceRoot });
    expect((await node.waitFor(/MATE_NODE_CONNECTED ([0-9a-f-]+)/i))[1]).toBe(nodeId);
    const restartedCookie = await login(origin);
    await waitForNodeOnline(origin, restartedCookie, nodeId);

    const restarted = (await (
      await fetch(new URL("/api/owner/agents", origin), { headers: { cookie: restartedCookie } })
    ).json()) as { agents: CreatedAgent[] };
    for (const [agent, workspace, memoryText] of [
      [first, firstWorkspace, "memory"],
      [second, secondWorkspace, "memory"],
    ] as const) {
      const after = restarted.agents.find((candidate) => candidate.id === agent.id);
      expect(after?.sessionId).toBe(agent.sessionId);
      expect(after?.linuxIdentity?.workspace).toBe(workspace);
      expect(lstatSync(workspace).isDirectory()).toBe(true);
      const memory = join(workspace, "MEMORY.md");
      expect((lstatSync(memory).mode & 0o777).toString(8)).toBe("600");
      expect(readFileSync(memory, "utf8")).toContain(memoryText);
    }
    expect(
      restarted.agents
        .filter((agent) => [first.id, second.id].includes(agent.id))
        .map((agent) => agent.linuxIdentity!.workspace)
        .sort(),
    ).toEqual([firstWorkspace, secondWorkspace].sort());
    // The boundary is still the same boundary after a restart, and the node re-verifies the other
    // Agent's workspace and its memory entry point from disk before serving it.
    expect((await preview(first.id, "")).status).toBe(200);
    expect((await preview(second.id, "")).status).toBe(200);
    expect((await preview(first.id, `../${second.id}/peer-notes.md`)).status).toBe(403);
    expect((await preview(first.id, "peer-link.md", "/chunk")).status).toBe(403);
    expect(readFileSync(join(secondWorkspace, "peer-notes.md"), "utf8")).toBe("peer notes\n");
  } finally {
    if (node) await stopProcess(node);
    if (control) await stopProcess(control);
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
