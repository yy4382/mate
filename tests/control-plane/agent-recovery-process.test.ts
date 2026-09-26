import { spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

const password = "recovery-process-owner-password";
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function eventually<T>(
  read: () => T | undefined,
  label: string,
  timeoutMs = 12000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await pause(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

class Child {
  output = "";
  constructor(readonly process: ChildProcess) {
    process.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      this.output += chunk;
    });
    process.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      this.output += chunk;
    });
  }
  async line(pattern: RegExp): Promise<RegExpMatchArray> {
    return eventually(() => this.output.match(pattern) ?? undefined, String(pattern));
  }
  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    this.process.kill(signal);
    await Promise.race([
      new Promise<void>((done) => this.process.once("exit", () => done())),
      pause(3000),
    ]);
    if (this.process.exitCode === null && this.process.signalCode === null)
      this.process.kill("SIGKILL");
  }
}

function startControl(directory: string): Child {
  return new Child(
    spawn(process.execPath, [resolve("dist/src/control-plane/main.js")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MATE_CONTROL_PLANE_PORT: "0",
        MATE_CONTROL_PLANE_DATA_DIR: join(directory, "control"),
        MATE_OWNER_PASSWORD_FILE: join(directory, "password"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function startNode(
  origin: string,
  directory: string,
  token: string | undefined,
  countFile: string,
  fault: "before_receipt" | "normal",
): Child {
  const client = pathToFileURL(resolve("dist/src/nodes/client.js")).href;
  const ledger = pathToFileURL(resolve("dist/src/nodes/process-operations.js")).href;
  const storage = pathToFileURL(resolve("dist/src/storage/initialize.js")).href;
  const worker = resolve("tests/fixtures/direct-message-model-worker.mjs");
  const runner = `
    const {runLinuxNodeWithTestDependencies}=await import(${JSON.stringify(client)});
    const {AgentProcessOperations}=await import(${JSON.stringify(ledger)});
    const {openNodeProcessDatabase}=await import(${JSON.stringify(storage)});
    const {appendFileSync,mkdirSync}=await import('node:fs');
    const {join}=await import('node:path');
    mkdirSync(process.env.MATE_NODE_DATA_DIR,{recursive:true,mode:0o700});
    const db=openNodeProcessDatabase(join(process.env.MATE_NODE_DATA_DIR,'agent-process-operations.sqlite'));
    const operations=new AgentProcessOperations(db,async () => {
      appendFileSync(process.env.MATE_COUNT_FILE,'executed\\n');
      if(process.env.MATE_FAULT==='before_receipt') await new Promise(() => {});
      return {state:'succeeded',receipt:{code:0,stdout:'executed',stderr:'',truncated:false}};
    });
    const controller=new AbortController();
    process.on('SIGTERM',()=>controller.abort());
    await runLinuxNodeWithTestDependencies({controlPlaneUrl:process.env.MATE_CONTROL_PLANE_URL,
      dataDirectory:process.env.MATE_NODE_DATA_DIR,agentHomeRoot:process.env.MATE_AGENT_HOME_ROOT,
      pairingToken:process.env.MATE_NODE_PAIRING_TOKEN,heartbeatIntervalMs:100,
      heartbeatTimeoutMs:2000},controller.signal,{
      modelWorkerEntry:${JSON.stringify(worker)},modelWorkerIdentity:null,processOperations:operations,
      provisionAgent:async (agentId)=>({username:'mate_'+agentId.replaceAll('-','').slice(0,27),
        uid:24001,gid:24001,home:process.env.MATE_AGENT_HOME_ROOT+'/'+agentId}),
    });
    db.close();
  `;
  return new Child(
    spawn(process.execPath, ["--input-type=module", "--eval", runner], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MATE_CONTROL_PLANE_URL: origin,
        MATE_NODE_DATA_DIR: directory,
        MATE_NODE_PAIRING_TOKEN: token,
        MATE_AGENT_HOME_ROOT: join(directory, "homes"),
        MATE_COUNT_FILE: countFile,
        MATE_FAULT: fault,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

async function owner(origin: string): Promise<string> {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  expect(response.status).toBe(204);
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

async function json(
  origin: string,
  cookie: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Record<string, any>> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? {} : (response.json() as Promise<Record<string, any>>);
}

function cpRow(
  directory: string,
  query: string,
  ...params: unknown[]
): Record<string, unknown> | undefined {
  const db = new Database(join(directory, "control", "control-plane.sqlite"), { readonly: true });
  try {
    return db.prepare(query).get(...params) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

it.each(["before_receipt", "after_receipt"] as const)(
  "recovers a real node %s fault without replaying its side effect while another Agent continues",
  async (fault) => {
    const directory = mkdtempSync(join(tmpdir(), "mate-recovery-process-"));
    chmodSync(directory, 0o700);
    writeFileSync(join(directory, "password"), `${password}\n`, { mode: 0o600 });
    const countFile = join(directory, "side-effects");
    writeFileSync(countFile, "");
    let control: Child | undefined, node: Child | undefined, onlineNode: Child | undefined;
    let origin = "",
      allowReconnect = true,
      dropped = false;
    const proxyHttp = createServer(),
      proxyWs = new WebSocketServer({ noServer: true });
    const sockets = new Set<WebSocket>();
    proxyHttp.on("upgrade", (request, network, head) => {
      if (!allowReconnect) {
        network.destroy();
        return;
      }
      proxyWs.handleUpgrade(request, network, head, (downstream) => {
        sockets.add(downstream);
        const upstream = new WebSocket(origin.replace(/^http/, "ws") + "/api/nodes/connect");
        sockets.add(upstream);
        downstream.on("message", (data, binary) => {
          const message = JSON.parse(data.toString()) as { type?: string };
          if (
            fault === "after_receipt" &&
            message.type === "node.process.operation.result" &&
            !dropped
          ) {
            dropped = true;
            allowReconnect = false;
            downstream.terminate();
            upstream.terminate();
            return;
          }
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        });
        upstream.on("message", (data, binary) => {
          if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
        });
        downstream.on("close", () => {
          sockets.delete(downstream);
          upstream.terminate();
        });
        upstream.on("close", () => {
          sockets.delete(upstream);
          downstream.terminate();
        });
        upstream.on("error", () => upstream.terminate());
      });
    });
    await new Promise<void>((done) => proxyHttp.listen(0, "127.0.0.1", () => done()));
    const proxyPort = (proxyHttp.address() as { port: number }).port;
    try {
      control = startControl(directory);
      origin = `http://127.0.0.1:${(await control.line(/MATE_CONTROL_PLANE_LISTENING (\d+)/))[1]}`;
      let cookie = await owner(origin);
      const token = (await json(origin, cookie, "/api/owner/nodes/pairing-tokens", "POST"))
        .pairingToken as string;
      node = startNode(
        `http://127.0.0.1:${proxyPort}`,
        join(directory, "fault-node"),
        token,
        countFile,
        fault === "before_receipt" ? "before_receipt" : "normal",
      );
      const faultNodeId = (await node.line(/MATE_NODE_PAIRED ([0-9a-f-]+)/))[1]!;
      const onlineToken = (await json(origin, cookie, "/api/owner/nodes/pairing-tokens", "POST"))
        .pairingToken as string;
      onlineNode = startNode(
        origin,
        join(directory, "online-node"),
        onlineToken,
        join(directory, "online-count"),
        "normal",
      );
      const onlineNodeId = (await onlineNode.line(/MATE_NODE_PAIRED ([0-9a-f-]+)/))[1]!;
      const faultAgentId = randomUUID(),
        onlineAgentId = randomUUID();
      for (const [agentId, nodeId, name] of [
        [faultAgentId, faultNodeId, "Fault Agent"],
        [onlineAgentId, onlineNodeId, "Online Agent"],
      ]) {
        await json(origin, cookie, "/api/owner/agents", "POST", {
          id: agentId,
          nodeId,
          name,
          role: "Synthetic recovery test",
          description: "Two-process fixture",
          model: { provider: "openai", id: "gpt-4o-mini" },
        });
      }
      const faultChannel = (
        await json(origin, cookie, `/api/owner/agents/${faultAgentId}/direct-channel`, "POST")
      ).channel.id as string;
      const onlineChannel = (
        await json(origin, cookie, `/api/owner/agents/${onlineAgentId}/direct-channel`, "POST")
      ).channel.id as string;
      await json(origin, cookie, "/api/owner/model-credentials/openai", "PUT", {
        apiKey: "synthetic-key-process-recovery",
      });
      await json(origin, cookie, `/api/owner/channels/${faultChannel}/messages`, "POST", {
        text: "Execute once.",
      });
      await eventually(
        () => (readFileSync(countFile, "utf8").includes("executed") ? true : undefined),
        "host side effect",
      );
      if (fault === "before_receipt") await node.stop("SIGKILL");
      else await eventually(() => (dropped ? true : undefined), "lost receipt ACK");
      await eventually(
        () =>
          cpRow(
            directory,
            "SELECT state FROM owner_agent_process_operations WHERE agent_id=?",
            faultAgentId,
          )?.state === "unknown"
            ? true
            : undefined,
        "unknown control-plane result",
      );
      expect(
        cpRow(
          directory,
          "SELECT state FROM owner_message_deliveries WHERE recipient_id=? ORDER BY seq LIMIT 1",
          faultAgentId,
        ),
      ).toMatchObject({ state: "pending" });
      expect(
        cpRow(
          directory,
          "SELECT error_code FROM owner_agent_runs WHERE agent_id=? ORDER BY started_at LIMIT 1",
          faultAgentId,
        ),
      ).toMatchObject({ error_code: "interrupted" });
      await json(origin, cookie, `/api/owner/channels/${onlineChannel}/messages`, "POST", {
        text: "Continue independently.",
      });
      await eventually(
        () =>
          cpRow(
            directory,
            "SELECT COUNT(*) AS count FROM owner_agent_runs WHERE agent_id=? AND state='completed'",
            onlineAgentId,
          )?.count === 1
            ? true
            : undefined,
        "unrelated online Agent completion",
      );
      await control.stop();
      control = startControl(directory);
      origin = `http://127.0.0.1:${(await control.line(/MATE_CONTROL_PLANE_LISTENING (\d+)/))[1]}`;
      cookie = await owner(origin);
      allowReconnect = true;
      if (fault === "before_receipt")
        node = startNode(
          `http://127.0.0.1:${proxyPort}`,
          join(directory, "fault-node"),
          undefined,
          countFile,
          "normal",
        );
      await eventually(
        () =>
          cpRow(
            directory,
            "SELECT state FROM owner_agent_process_operations WHERE agent_id=?",
            faultAgentId,
          )?.state === (fault === "after_receipt" ? "succeeded" : "unknown")
            ? true
            : undefined,
        "reconciled result",
        15000,
      );
      await eventually(
        () =>
          cpRow(
            directory,
            "SELECT COUNT(*) AS count FROM owner_agent_runs WHERE agent_id=? AND state='completed'",
            faultAgentId,
          )?.count === 1
            ? true
            : undefined,
        "recovered Agent completion",
        15000,
      );
      expect(readFileSync(countFile, "utf8").trim().split("\n")).toHaveLength(1);
      const activity = await json(origin, cookie, `/api/owner/agents/${faultAgentId}/activity`);
      expect(
        activity.events.some((event: { kind: string }) => event.kind === "run.interrupted"),
      ).toBe(true);
      if (fault === "after_receipt")
        expect(
          activity.events.some((event: { kind: string }) => event.kind === "receipt.corrected"),
        ).toBe(true);
    } finally {
      await node?.stop("SIGKILL");
      await onlineNode?.stop("SIGKILL");
      await control?.stop();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((done) => proxyWs.close(() => done()));
      await new Promise<void>((done) => proxyHttp.close(() => done()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
  45000,
);

it("classifies Pi HTTP response failures as credential pause or temporary backoff", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-model-response-"));
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, "password"), `${password}\n`, { mode: 0o600 });
  let control: Child | undefined, node: Child | undefined;
  try {
    control = startControl(directory);
    const origin = `http://127.0.0.1:${(await control.line(/MATE_CONTROL_PLANE_LISTENING (\d+)/))[1]}`;
    const cookie = await owner(origin);
    const token = (await json(origin, cookie, "/api/owner/nodes/pairing-tokens", "POST"))
      .pairingToken as string;
    node = startNode(origin, join(directory, "node"), token, join(directory, "unused"), "normal");
    const nodeId = (await node.line(/MATE_NODE_PAIRED ([0-9a-f-]+)/))[1]!;
    const agentId = randomUUID();
    await json(origin, cookie, "/api/owner/agents", "POST", {
      id: agentId,
      nodeId,
      name: "Response Agent",
      role: "Verify Pi response",
      description: "Test",
      model: { provider: "openai", id: "gpt-4o-mini" },
    });
    const channelId = (
      await json(origin, cookie, `/api/owner/agents/${agentId}/direct-channel`, "POST")
    ).channel.id as string;
    await json(origin, cookie, "/api/owner/model-credentials/openai", "PUT", {
      apiKey: "synthetic-key-http-401",
    });
    await json(origin, cookie, `/api/owner/channels/${channelId}/messages`, "POST", {
      text: "First request",
    });
    await eventually(
      () =>
        cpRow(
          directory,
          "SELECT error_code FROM owner_agent_runs WHERE agent_id=? ORDER BY started_at LIMIT 1",
          agentId,
        )?.error_code === "credentials_invalid"
          ? true
          : undefined,
      "Pi HTTP 401 credential classification",
    );
    let activity = await json(origin, cookie, `/api/owner/agents/${agentId}/activity`);
    expect(activity.pausedReason).toBe("credentials");
    await json(origin, cookie, "/api/owner/model-credentials/openai", "PUT", {
      apiKey: "synthetic-key-http-503",
    });
    await eventually(
      () =>
        cpRow(
          directory,
          "SELECT error_code,retry_at FROM owner_agent_runs WHERE agent_id=? ORDER BY started_at DESC LIMIT 1",
          agentId,
        )?.error_code === "model_failed"
          ? true
          : undefined,
      "Pi HTTP 503 temporary classification",
    );
    activity = await json(origin, cookie, `/api/owner/agents/${agentId}/activity`);
    expect(activity.pausedReason).toBeNull();
    const failed = cpRow(
      directory,
      "SELECT error_code,retry_at,completed_at FROM owner_agent_runs WHERE agent_id=? ORDER BY started_at DESC LIMIT 1",
      agentId,
    )!;
    expect(failed.error_code).toBe("model_failed");
    expect(Number(failed.retry_at)).toBeGreaterThan(Number(failed.completed_at));
  } finally {
    await node?.stop("SIGKILL");
    await control?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
