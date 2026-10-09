import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { NodeControlMessageSchema, NodeRequestSchema, type NodeRequest } from "@mate/protocol";
import { runLinuxNodeWithTestDependencies } from "@mate/node";
import { LinuxWorkspaceExecutor } from "@mate/node/workspace-execution";
import { bindToolSocket, toolTestApp, toolTestInput } from "../../support/agent/tool-run.js";
import { eventually } from "../../support/environment/run-services.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

function event() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, resolve };
}

async function fixture(options: { nodeOperationTimeoutMs?: number } = {}) {
  const resourceReleases: Array<() => void | Promise<void>> = [];
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      const failures: unknown[] = [];
      for (const release of resourceReleases.splice(0).reverse()) {
        try {
          await release();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Reconciliation fixture cleanup failed");
    })();
    return closing;
  };
  cleanups.push(close);
  const directory = mkdtempSync(join(tmpdir(), "mate-workspace-reconciliation-"));
  resourceReleases.push(() => rmSync(directory, { recursive: true, force: true }));
  chmodSync(directory, 0o700);
  const passwordFile = join(directory, "owner-password");
  const password = "synthetic-reconciliation-password";
  writeFileSync(passwordFile, password, { mode: 0o600 });
  const app = toolTestApp({ dataDir: join(directory, "control"), passwordFile, ...options });
  resourceReleases.push(() => app.close());
  const db = new Database(join(directory, "control", "control-plane.sqlite"));
  resourceReleases.push(() => {
    db.close();
  });
  const login = await app.http.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  expect(login.status, await login.clone().text()).toBe(204);
  const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
  const api = async (path: string, body?: unknown) => {
    const response = await app.http.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.ok, await response.clone().text()).toBe(true);
    return response.json();
  };
  const pairing = await api("/api/owner/nodes/pairing-tokens", {});
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  resourceReleases.push(async () => {
    for (const socket of server.clients) socket.terminate();
    if (!server.address()) return;
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
  });
  const sent: string[] = [];
  const received: NodeRequest[] = [];
  const heartbeats: Array<Extract<NodeRequest, { type: "node.ping" }>> = [];
  const errors: unknown[] = [];
  const sockets: Array<Parameters<typeof app.nodes.open>[0] & { sent: string[] }> = [];
  let holdHeartbeats = false;
  server.on("connection", (network) => {
    const socket = {
      sent,
      send(data: string) {
        sent.push(data);
        network.send(data);
      },
      close: () => network.close(),
      terminate: () => network.terminate(),
    };
    sockets.push(socket);
    app.nodes.open(socket);
    network.on("message", (data) => {
      const request = NodeRequestSchema.parse(JSON.parse(data.toString()));
      if (holdHeartbeats && request.type === "node.ping") {
        heartbeats.push(request);
        return;
      }
      if (request.type === "node.pair" || request.type === "node.authenticate")
        bindToolSocket(app, request.nodeId, socket);
      void app.nodes.receive(socket, data).then(
        () => received.push(request),
        (error: unknown) => errors.push(error),
      );
    });
    network.on("close", () => app.nodes.close(socket));
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      done();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing WebSocket port");
  const controller = new AbortController();
  const workspaceRoot = join(directory, "workspaces");
  const nodeData = join(directory, "node");
  const beforeReceipt = event();
  const releaseReceipt = event();
  const node = runLinuxNodeWithTestDependencies(
    {
      controlPlaneUrl: `http://127.0.0.1:${address.port}`,
      dataDirectory: nodeData,
      agentWorkspaceRoot: workspaceRoot,
      pairingToken: pairing.pairingToken,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 2000,
    },
    controller.signal,
    {
      workspaceExecutor: new LinuxWorkspaceExecutor(workspaceRoot, nodeData, {
        beforeReceipt: async () => {
          beforeReceipt.resolve();
          await releaseReceipt.promise;
        },
      }),
    },
  );
  // Observe a fatal node error immediately; cleanup still awaits and reports the rejection.
  void node.catch((error: unknown) => errors.push(error));
  resourceReleases.push(async () => {
    releaseReceipt.resolve();
    controller.abort();
    await node;
  });
  const paired = await eventually(
    () => received.find((message) => message.type === "node.pair"),
    "real node pairing",
  );
  if (paired.type !== "node.pair") throw new Error("Expected node pairing");
  const nodeId = paired.nodeId;
  const created = await api("/api/owner/agents", {
    id: randomUUID(),
    nodeId,
    name: "文件同事",
    role: "写入合成文件",
    description: "Synthetic receipt interleaving",
    model: { provider: "openai", id: "gpt-4.1" },
  });
  const agentId = z.object({ agent: z.object({ id: z.string() }) }).parse(created).agent.id;
  const direct = await api(`/api/owner/agents/${agentId}/direct-channel`, {});
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-no-provider-request" }),
  });
  app.chat.messages.createMessage({
    channelId: direct.channel.id,
    text: "写一份合成文件后保持静默。",
  });
  const run = await eventually(() => {
    for (const text of sent) {
      const parsed = z
        .object({
          type: z.literal("test.run.started"),
          runId: z.string(),
          agentId: z.string(),
          actionScopeId: z.string(),
        })
        .safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    }
    return undefined;
  }, "original Agent run");
  holdHeartbeats = true;
  return {
    app,
    db,
    api,
    agentId,
    nodeId,
    run,
    directory,
    beforeReceipt,
    releaseReceipt,
    controls: () =>
      sent.flatMap((text) => {
        const parsed = NodeControlMessageSchema.safeParse(JSON.parse(text));
        return parsed.success ? [parsed.data] : [];
      }),
    disconnect() {
      sockets.at(-1)!.terminate();
    },
    async reconnect() {
      await eventually(
        () =>
          sockets.length > 1 &&
          sent.some((text) => {
            const parsed = NodeControlMessageSchema.safeParse(JSON.parse(text));
            return parsed.success && parsed.data.type === "control.authenticated";
          })
            ? true
            : undefined,
        "same node reconnection",
      );
    },
    async heartbeat() {
      const heartbeat = await eventually(() => heartbeats.shift(), "periodic node heartbeat");
      await app.nodes.receive(sockets.at(-1)!, JSON.stringify(heartbeat));
      await eventually(() => {
        const queries = sent.flatMap((text) => {
          const parsed = NodeControlMessageSchema.safeParse(JSON.parse(text));
          return parsed.success && parsed.data.type === "control.workspace.reconcile"
            ? [parsed.data]
            : [];
        });
        return queries.every((query) =>
          received.some((message) => message.requestId === query.requestId),
        )
          ? true
          : undefined;
      }, "periodic reconciliation round trip");
      expect(errors).toEqual([]);
    },
    async finish() {
      await toolTestInput(
        app,
        sockets[0]!,
        JSON.stringify({ ...run, type: "run.complete", ok: true }),
      );
    },
    close,
  };
}

const actionStateSchema = z.object({ state: z.string() });
function actionState(db: Database.Database) {
  const row = z
    .object({ result_json: z.string() })
    .parse(
      db
        .prepare(
          "SELECT result_json FROM owner_agent_tool_actions WHERE operation='workspace.write'",
        )
        .get(),
    );
  return actionStateSchema.parse(JSON.parse(row.result_json)).state;
}

it("keeps a real file write executing during periodic reconciliation without a recovery delivery or new run", async () => {
  const context = await fixture();
  try {
    const result = context.app.tools.execute(
      {
        ...context.run,
        nodeId: context.nodeId,
        toolCallId: `mate:${context.run.actionScopeId}:${"a".repeat(64)}:1`,
      },
      "tools.call",
      { name: "workspace.write", input: { path: "report.txt", content: "2,4,6\n" } },
    );
    await Promise.race([
      context.beforeReceipt.promise,
      result.then((value) => {
        throw new Error(
          `File operation returned before the receipt gate: ${JSON.stringify(value)}`,
        );
      }),
    ]);
    expect(actionState(context.db)).toBe("executing");
    await context.heartbeat();
    expect(actionState(context.db)).toBe("executing");
    context.releaseReceipt.resolve();
    await expect(result).resolves.toMatchObject({
      ok: true,
      result: { sha256: expect.any(String) },
    });
    expect(actionState(context.db)).toBe("succeeded");
    const agents = await context.api("/api/owner/agents");
    expect(readFileSync(join(agents.agents[0].linuxIdentity.workspace, "report.txt"), "utf8")).toBe(
      "2,4,6\n",
    );
    await context.finish();
    await context.heartbeat();
    const activity = await context.api(`/api/owner/agents/${context.agentId}/activity`);
    expect(JSON.stringify(activity)).not.toContain("receipt.corrected");
    expect(
      context.db
        .prepare(
          "SELECT COUNT(*) AS count FROM owner_message_deliveries WHERE recipient_kind='agent' AND recipient_id=?",
        )
        .get(context.agentId),
    ).toEqual({ count: 1 });
    expect(
      context.db
        .prepare("SELECT COUNT(*) AS count FROM owner_agent_runs WHERE agent_id=?")
        .get(context.agentId),
    ).toEqual({ count: 1 });
  } finally {
    await context.close();
  }
}, 15_000);

it.each(["timeout", "disconnect"] as const)(
  "%s releases the current wait so missing and later valid real receipts reconcile without replay or removing manual pause",
  async (cause) => {
    const context = await fixture({ nodeOperationTimeoutMs: 500 });
    try {
      const result = context.app.tools.execute(
        {
          runId: context.run.runId,
          agentId: context.agentId,
          nodeId: context.nodeId,
          toolCallId: `mate:${context.run.actionScopeId}:${"b".repeat(64)}:1`,
        },
        "tools.call",
        { name: "workspace.write", input: { path: "late.txt", content: "once\n" } },
      );
      await context.beforeReceipt.promise;
      const original = context
        .controls()
        .find((message) => message.type === "control.workspace.operation");
      if (!original || original.type !== "control.workspace.operation")
        throw new Error("Missing original write request");
      if (cause === "disconnect") context.disconnect();
      await expect(result).resolves.toMatchObject({
        ok: false,
        error: expect.any(String),
      });
      expect(actionState(context.db)).toBe("unknown");
      if (cause === "disconnect") await context.reconnect();
      await context.heartbeat();
      expect(actionState(context.db)).toBe("unknown");
      expect(
        context
          .controls()
          .filter((message) => message.type === "control.workspace.reconcile")
          .flatMap((message) => message.operations),
      ).toContainEqual({
        operationId: original.operationId,
        agentId: context.agentId,
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(context.app.runs?.pauseAgent(context.agentId)).toBe(true);
      context.releaseReceipt.resolve();
      await eventually(() => {
        const path = join(
          context.directory,
          "node",
          "workspace-receipts",
          `${original.operationId}.json`,
        );
        const receipt = z
          .object({ state: z.string() })
          .parse(JSON.parse(readFileSync(path, "utf8")));
        return receipt.state === "succeeded" ? true : undefined;
      }, "real durable late file receipt");
      await context.heartbeat();
      await eventually(
        () => (actionState(context.db) === "succeeded" ? true : undefined),
        "valid late receipt correction",
      );
      const activity = await context.api(`/api/owner/agents/${context.agentId}/activity`);
      expect(JSON.stringify(activity)).toContain("receipt.corrected");
      const agents = await context.api("/api/owner/agents");
      expect(agents.agents[0].pausedReason).toBe("manual");
      expect(readFileSync(join(agents.agents[0].linuxIdentity.workspace, "late.txt"), "utf8")).toBe(
        "once\n",
      );
      expect(
        context.controls().filter((message) => message.type === "control.workspace.operation"),
      ).toHaveLength(1);
      expect(
        context.db
          .prepare("SELECT COUNT(*) AS count FROM owner_agent_sessions WHERE agent_id=?")
          .get(context.agentId),
      ).toEqual({ count: 1 });
    } finally {
      await context.close();
    }
  },
  15_000,
);
