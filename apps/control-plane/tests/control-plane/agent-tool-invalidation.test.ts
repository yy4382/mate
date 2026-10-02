import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { WebSocket, WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { z } from "zod";
import { workspaceReceiptRequestHash } from "@mate/protocol/node";
import { fileModelCorrections } from "../helpers/scenario-file-facts.js";
import {
  eventually,
  login,
  ownerPassword,
  startControlPlane,
  startNode,
  stopProcess,
  ProcessOutput,
} from "../helpers/run-services.js";

function providerReply(response: ServerResponse, step: number, calls: unknown[]) {
  const output = calls.length
    ? calls
    : [
        {
          type: "message",
          id: `msg_${step}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Synthetic completion", annotations: [] }],
        },
      ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  output.forEach((item, index) =>
    response.write(
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index: index, item })}\n\n`,
    ),
  );
  response.end(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: `response-${step}`,
        status: "completed",
        output,
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          total_tokens: 110,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    })}\n\n`,
  );
}

function toolCall(step: number, name: string, input: unknown) {
  return {
    type: "function_call",
    id: `fc_${step}_${name}`,
    call_id: `call_${step}_${name}`,
    name: "tools.call",
    arguments: JSON.stringify({ name, input }),
    status: "completed",
  };
}

function pausedCommitControlPlane(directory: string): ProcessOutput {
  const runner = `
    const { startControlPlane } = await import(${JSON.stringify(new URL("../../dist/main.js", import.meta.url).href)});
    const { existsSync } = await import('node:fs');
    let paused = false;
    startControlPlane(0, undefined, {
      dataDir: ${JSON.stringify(join(directory, "control-plane-data"))},
      passwordFile: ${JSON.stringify(join(directory, "owner-password"))},
    }, { modelForRun: (model, apiKey) => ({ ...model, baseUrl: apiKey }), beforeAgentAttachmentCommit: async () => {
      if (paused) return;
      paused = true;
      console.log('MATE_ATTACHMENT_BEFORE_COMMIT');
      while (!existsSync(${JSON.stringify(join(directory, "release-commit"))}))
        await new Promise(done => setTimeout(done, 10));
    } });`;
  return new ProcessOutput(
    spawn(process.execPath, ["--input-type=module", "--eval", runner], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function pausedReceiptNode(directory: string, origin: string, pairingToken: string): ProcessOutput {
  const runner = `
    const { runLinuxNodeWithTestDependencies } = await import(${JSON.stringify(import.meta.resolve("@mate/node"))});
    const { AgentProcessOperations } = await import(${JSON.stringify(import.meta.resolve("@mate/node/process-operations"))});
    const { createLinuxAgentProcessExecutor } = await import(${JSON.stringify(import.meta.resolve("@mate/node/linux-process-executor"))});
    const { openNodeProcessDatabase } = await import(${JSON.stringify(import.meta.resolve("@mate/node/database"))});
    const { LinuxWorkspaceExecutor } = await import(${JSON.stringify(import.meta.resolve("@mate/node/workspace-execution"))});
    const { mkdirSync, chmodSync } = await import('node:fs');
    const data = ${JSON.stringify(join(directory, "node-data"))};
    const root = ${JSON.stringify(join(directory, "workspaces"))};
    mkdirSync(data, { recursive: true, mode: 0o700 });
    const db = openNodeProcessDatabase(data + '/agent-process-operations.sqlite');
    chmodSync(data + '/agent-process-operations.sqlite', 0o600);
    const execute = createLinuxAgentProcessExecutor(root, { commandTimeoutMs: 700 });
    const pause = async () => { console.log('MATE_OPERATION_BEFORE_RECEIPT'); await new Promise(() => {}); };
    const operations = new AgentProcessOperations(db, async request => {
      const result = await execute(request);
      if (request.operation.kind === 'exec' && request.operation.command.includes('effect-count.txt')) await pause();
      return result;
    });
    const controller = new AbortController();
    process.on('SIGTERM', () => controller.abort());
    await runLinuxNodeWithTestDependencies({ controlPlaneUrl: ${JSON.stringify(origin)},
      dataDirectory: data, agentWorkspaceRoot: root, pairingToken: ${JSON.stringify(pairingToken)},
      heartbeatIntervalMs: 30000, heartbeatTimeoutMs: 60000 }, controller.signal, {

      processOperations: operations,
      workspaceExecutor: new LinuxWorkspaceExecutor(root, data, { beforeReceipt: pause }),
    });`;
  return new ProcessOutput(
    spawn(process.execPath, ["--input-type=module", "--eval", runner], {
      env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

it.each([
  ["pause", "chunk", "attachment"],
  ["pause", "commit", "attachment"],
  ["credentials", "chunk", "attachment"],
  ["credentials", "commit", "attachment"],
  ["disconnect", "chunk", "attachment"],
  ["disconnect", "commit", "attachment"],
  ["pause", "receipt", "command"],
  ["pause", "receipt", "file"],
  ["credentials", "receipt", "command"],
  ["credentials", "receipt", "file"],
  ["disconnect", "receipt", "command"],
  ["disconnect", "receipt", "file"],
  ["restart", "receipt", "command"],
  ["restart", "receipt", "file"],
  ["disconnect", "unconfirmed", "command"],
  ["disconnect", "unconfirmed", "file"],
] as const)(
  "%s at %s stops the old %s tool while receipts and the same session recover",
  async (cause, boundary, firstTool) => {
    const directory = mkdtempSync(join(tmpdir(), "mate-tool-invalidation-"));
    chmodSync(directory, 0o700);
    writeFileSync(join(directory, "owner-password"), ownerPassword, { mode: 0o600 });
    let control: ProcessOutput | undefined,
      node: ProcessOutput | undefined,
      db: Database.Database | undefined;
    let origin = "",
      dm = "",
      held: { socket: WebSocket; data: Buffer; binary: boolean } | undefined;
    let currentUpstream: WebSocket | undefined;
    const wire: any[] = [],
      requests: any[] = [],
      sockets = new Set<WebSocket>();
    let releaseRecovery!: () => void;
    const recovery = new Promise<void>((done) => {
      releaseRecovery = done;
    });
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const step = requests.length - 1;
      if (step > 0) await recovery;
      providerReply(
        response,
        step,
        step === 0
          ? [
              firstTool === "attachment"
                ? toolCall(step, "attachments.publish", { conversationId: dm, path: "large.txt" })
                : firstTool === "command"
                  ? toolCall(step, "process.exec", {
                      command: "printf 'once\\n' >> effect-count.txt",
                    })
                  : toolCall(step, "workspace.edit", {
                      path: "normal.txt",
                      expectedHash: createHash("sha256").update("normal contents").digest("hex"),
                      oldText: "normal contents",
                      newText: "normal contents\nonce",
                    }),
            ]
          : step === 1
            ? [
                toolCall(step, "workspace.read", { path: "normal.txt" }),
                toolCall(step, "attachments.publish", {
                  conversationId: dm,
                  path: "normal.txt",
                  filename: "resumed.txt",
                }),
                toolCall(step, "process.exec", {
                  command: "printf 'once\\n' >> resumed-count.txt",
                }),
              ]
            : [],
      );
    });
    const proxyHttp = createServer(),
      proxyWs = new WebSocketServer({ noServer: true });
    let holdRead = boundary === "chunk";
    let holdReceipt = boundary === "receipt";
    const operations = new Map<string, any>();
    proxyHttp.on("upgrade", (request, network, head) => {
      proxyWs.handleUpgrade(request, network, head, (downstream) => {
        const upstream = new WebSocket(origin.replace(/^http/, "ws") + "/api/nodes/connect");
        currentUpstream = upstream;
        sockets.add(downstream);
        sockets.add(upstream);
        downstream.on("message", (data, binary) => {
          const message = JSON.parse(data.toString());
          wire.push(message);
          const operation = operations.get(message.requestId);
          if (
            holdRead &&
            message.type === "node.workspace.operation.result" &&
            operation?.kind === "workspace_read_chunk"
          ) {
            holdRead = false;
            held = { socket: upstream, data: Buffer.from(data as Buffer), binary };
            return;
          }
          if (
            holdReceipt &&
            ((firstTool === "command" && message.type === "node.process.operation.result") ||
              (firstTool === "file" &&
                message.type === "node.workspace.operation.result" &&
                operation?.kind === "edit"))
          ) {
            holdReceipt = false;
            held = { socket: upstream, data: Buffer.from(data as Buffer), binary };
            return;
          }
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        });
        upstream.on("message", (data, binary) => {
          const message = JSON.parse(data.toString());
          wire.push(message);
          if (message.type === "control.workspace.operation")
            operations.set(message.requestId, message.operation);
          if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
        });
        downstream.on("error", () => {});
        upstream.on("error", () => {});
        downstream.on("close", () => upstream.terminate());
        upstream.on("close", () => downstream.terminate());
      });
    });
    await Promise.all([
      new Promise<void>((done) => provider.listen(0, "127.0.0.1", done)),
      new Promise<void>((done) => proxyHttp.listen(0, "127.0.0.1", done)),
    ]);
    const providerAddress = provider.address(),
      proxyAddress = proxyHttp.address();
    if (
      !providerAddress ||
      typeof providerAddress === "string" ||
      !proxyAddress ||
      typeof proxyAddress === "string"
    )
      throw new Error("Missing test server port");
    try {
      control =
        boundary === "commit" ? pausedCommitControlPlane(directory) : startControlPlane(directory);
      origin = `http://127.0.0.1:${(await control.waitFor(/MATE_CONTROL_PLANE_LISTENING (\d+)/))[1]}`;
      const cookie = await login(origin);
      const api = async (path: string, body?: unknown, method = "POST") => {
        const response = await fetch(origin + path, {
          method,
          headers: { cookie, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        expect(response.ok, await response.clone().text()).toBe(true);
        return response.status === 204 ? undefined : response.json();
      };
      const pairing = await api("/api/owner/nodes/pairing-tokens");
      const nodeOptions = {
        origin: `http://127.0.0.1:${proxyAddress.port}`,
        nodeData: join(directory, "node-data"),
        workspaceRoot: join(directory, "workspaces"),
      };
      node =
        boundary === "unconfirmed"
          ? pausedReceiptNode(directory, nodeOptions.origin, pairing.pairingToken)
          : startNode({ ...nodeOptions, pairingToken: pairing.pairingToken });
      const nodeId = (await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/i))[1]!;
      const agentId = randomUUID();
      const created = await api("/api/owner/agents", {
        id: agentId,
        nodeId,
        name: "Synthetic publisher",
        role: "Synthetic",
        description: "Synthetic",
        model: { provider: "openai", id: "gpt-4o-mini" },
      });
      dm = (await api(`/api/owner/agents/${agentId}/direct-channel`)).channel.id;
      writeFileSync(join(created.agent.linuxIdentity.workspace, "large.txt"), "x".repeat(20_000));
      writeFileSync(join(created.agent.linuxIdentity.workspace, "normal.txt"), "normal contents");
      await api(
        "/api/owner/model-credentials/openai",
        { apiKey: `http://127.0.0.1:${providerAddress.port}/v1` },
        "PUT",
      );
      db = new Database(join(directory, "control-plane-data", "control-plane.sqlite"), {
        readonly: true,
      });
      await api(`/api/owner/channels/${dm}/messages`, { text: "Publish the synthetic file" });
      if (boundary === "unconfirmed") await node.waitFor(/MATE_OPERATION_BEFORE_RECEIPT/);
      else if (boundary !== "commit")
        await eventually(
          () => held,
          boundary === "chunk"
            ? "first real file chunk returned by node"
            : "real operation receipt persisted and returned by node",
        );
      else await control.waitFor(/MATE_ATTACHMENT_BEFORE_COMMIT/);
      const oldRun = db
        .prepare(
          "SELECT r.id AS runId,r.delivery_id AS actionScopeId,s.id AS sessionId FROM owner_agent_runs r JOIN owner_agent_sessions s ON s.agent_id=r.agent_id WHERE r.agent_id=? ORDER BY r.rowid LIMIT 1",
        )
        .get(agentId) as any;
      const oldReceipt =
        boundary === "receipt"
          ? JSON.parse(held!.data.toString())
          : boundary === "unconfirmed"
            ? wire.find(
                (message) =>
                  message.type ===
                    (firstTool === "command"
                      ? "control.process.operation"
                      : "control.workspace.operation") &&
                  message.operation.kind === (firstTool === "command" ? "exec" : "edit"),
              )
            : undefined;
      let nodeReceipt: any;
      if (oldReceipt) {
        // Observe the real durable evidence separately from both the synthetic filesystem effect
        // and the CP's receipt. The result has been held at the wire, so the CP still has its intent.
        if (firstTool === "command") {
          const ledger = new Database(
            join(directory, "node-data", "agent-process-operations.sqlite"),
            { readonly: true },
          );
          try {
            nodeReceipt = ledger
              .prepare("SELECT * FROM agent_process_operations WHERE operation_id=?")
              .get(oldReceipt.operationId);
          } finally {
            ledger.close();
          }
          expect(nodeReceipt).toMatchObject({
            operation_id: oldReceipt.operationId,
            agent_id: agentId,
            state: boundary === "unconfirmed" ? "started" : "succeeded",
            revision: boundary === "unconfirmed" ? 1 : oldReceipt.revision,
          });
          if (boundary === "unconfirmed") expect(nodeReceipt.receipt).toBeNull();
          else expect(JSON.parse(nodeReceipt.receipt)).toEqual(oldReceipt.receipt);
          expect(
            readFileSync(join(created.agent.linuxIdentity.workspace, "effect-count.txt"), "utf8"),
          ).toBe("once\n");
          expect(
            db
              .prepare(
                "SELECT state,node_receipt_confirmed FROM owner_agent_process_operations WHERE operation_id=?",
              )
              .get(oldReceipt.operationId),
          ).toEqual({ state: "executing", node_receipt_confirmed: 0 });
        } else {
          nodeReceipt = JSON.parse(
            readFileSync(
              join(directory, "node-data", "workspace-receipts", `${oldReceipt.operationId}.json`),
              "utf8",
            ),
          );
          expect(nodeReceipt).toMatchObject({
            operationId: oldReceipt.operationId,
            agentId,
            state: boundary === "unconfirmed" ? "executing" : "succeeded",
            revision: boundary === "unconfirmed" ? 1 : oldReceipt.revision,
          });
          if (boundary === "unconfirmed") expect(nodeReceipt.result).toBeUndefined();
          else expect(nodeReceipt.result).toEqual(oldReceipt.result);
          expect(
            readFileSync(join(created.agent.linuxIdentity.workspace, "normal.txt"), "utf8"),
          ).toBe("normal contents\nonce");
          const row = db
            .prepare(
              "SELECT result_json FROM owner_agent_tool_actions WHERE operation='workspace.edit'",
            )
            .get() as { result_json: string };
          expect(JSON.parse(row.result_json).state).toBe("executing");
        }
      }
      if (cause === "pause") await api(`/api/owner/agents/${agentId}/pause`);
      else if (cause === "credentials")
        await api(
          "/api/owner/model-credentials/openai",
          { apiKey: `http://127.0.0.1:${providerAddress.port}/changed` },
          "PUT",
        );
      else {
        const reconnectStart = wire.length;
        if (boundary === "unconfirmed" || cause === "restart") {
          node.child.kill("SIGKILL");
          await node.exited;
        } else currentUpstream!.terminate();
        await eventually(() => {
          const row = db!
            .prepare("SELECT state FROM owner_agent_runs WHERE id=?")
            .get(oldRun.runId) as { state: string };
          return row.state === "failed" ? true : undefined;
        }, "node disconnect to invalidate its old run");
        if (boundary === "unconfirmed" || cause === "restart") node = startNode(nodeOptions);
        await eventually(
          () =>
            wire.slice(reconnectStart).find((message) => message.type === "control.authenticated"),
          "rapid node reconnection",
        );
      }
      if (boundary !== "commit" && cause !== "disconnect" && cause !== "restart")
        held!.socket.send(held!.data, { binary: held!.binary });
      else writeFileSync(join(directory, "release-commit"), "release");
      if (firstTool === "attachment") {
        await eventually(() => {
          const row = db!
            .prepare(
              "SELECT result_json FROM owner_agent_tool_actions WHERE operation='attachments.publish'",
            )
            .get() as { result_json: string };
          return ["failed", "succeeded"].includes(JSON.parse(row.result_json).state)
            ? true
            : undefined;
        }, "old attachment tool to settle");
        expect(
          wire
            .filter(
              (message) =>
                message.type === "control.workspace.operation" && message.mode === "agent_publish",
            )
            .map((message) => message.operation.kind),
        ).toEqual(
          boundary === "chunk"
            ? ["workspace_stat", "workspace_read_chunk"]
            : [
                "workspace_stat",
                "workspace_read_chunk",
                "workspace_read_chunk",
                "workspace_read_chunk",
                "workspace_stat",
              ],
        );
      } else {
        await eventually(() => {
          if (firstTool === "command") {
            const row = db!
              .prepare("SELECT * FROM owner_agent_process_operations WHERE operation_id=?")
              .get(oldReceipt.operationId) as any;
            // Disconnect first records a local unknown; reconciliation confirms the node receipt later.
            if (
              row?.state !== (boundary === "unconfirmed" ? "unknown" : "succeeded") ||
              row.node_receipt_confirmed !== 1
            )
              return undefined;
            expect(row).toMatchObject({
              operation_id: oldReceipt.operationId,
              agent_id: agentId,
              run_id: oldRun.runId,
              node_receipt_confirmed: 1,
              node_receipt_revision: boundary === "unconfirmed" ? 2 : nodeReceipt.revision,
            });
            if (boundary === "unconfirmed")
              expect(JSON.parse(row.receipt_json)).toEqual({
                reason: "node_restarted_during_operation",
              });
            else expect(JSON.parse(row.receipt_json)).toEqual(oldReceipt.receipt);
            expect(JSON.parse(nodeReceipt.request)).toEqual({
              agentId,
              operation: JSON.parse(row.request_json).operation,
            });
          } else {
            const row = db!
              .prepare(
                "SELECT result_json FROM owner_agent_tool_actions WHERE operation='workspace.edit'",
              )
              .get() as { result_json: string };
            const receipt = JSON.parse(row.result_json);
            if (receipt.state !== (boundary === "unconfirmed" ? "unknown" : "succeeded"))
              return undefined;
            if (boundary === "unconfirmed" && !receipt.error?.includes("No durable node receipt"))
              return undefined;
            expect(receipt).toMatchObject({
              operationId: oldReceipt.operationId,
              nodeRequestHash: nodeReceipt.requestHash,
            });
            if (boundary === "unconfirmed") {
              expect(receipt.revision).toBeUndefined();
              expect(receipt.error).toContain("result is unknown");
              const reconciliation = wire.find(
                (message) => message.type === "node.workspace.reconcile.result",
              );
              expect(reconciliation.receipts).toEqual([]);
            } else {
              expect(receipt.revision).toBe(nodeReceipt.revision);
              expect(receipt.result).toEqual(JSON.parse(oldReceipt.result.stdout));
            }
          }
          return true;
        }, "late durable operation evidence accepted after run invalidation");
      }
      expect(
        (await api(`/api/owner/channels/${dm}/attachments`, undefined, "GET")).attachments,
      ).toEqual([]);
      const interrupted = {
        state: "failed",
        error_code:
          cause === "pause"
            ? "manual_pause"
            : cause === "credentials"
              ? "configuration_changed"
              : "interrupted",
      };
      expect(
        db.prepare("SELECT state,error_code FROM owner_agent_runs WHERE id=?").get(oldRun.runId),
      ).toEqual(interrupted);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM owner_agent_session_records WHERE run_id=? AND json_extract(payload_json,'$.message.role')='toolResult'",
          )
          .get(oldRun.runId),
      ).toEqual({ n: 0 });
      if (cause === "pause") {
        const reconnectStart = wire.length;
        currentUpstream!.terminate();
        await eventually(
          () =>
            wire.slice(reconnectStart).find((message) => message.type === "control.authenticated"),
          "paused node to reconnect",
        );
        expect(
          (await api(`/api/owner/agents/${agentId}/activity`, undefined, "GET")).pausedReason,
        ).toBe("manual");
      }
      releaseRecovery();
      if (cause === "pause") await api(`/api/owner/agents/${agentId}/resume`);
      await eventually(() => {
        const row = db!
          .prepare(
            "SELECT COUNT(*) AS n FROM owner_agent_runs WHERE agent_id=? AND state='completed'",
          )
          .get(agentId) as { n: number };
        // A late receipt can independently queue a correction delivery after recovery admission.
        // Its subsequent run is valid; the recovered work must complete rather than total exactly one.
        return row.n >= 1 ? true : undefined;
      }, "new run to complete");
      const attachments = (await api(`/api/owner/channels/${dm}/attachments`, undefined, "GET"))
        .attachments;
      expect(attachments).toMatchObject([
        {
          filename: "resumed.txt",
          size: firstTool === "file" ? 20 : 15,
          uploader: { kind: "agent", id: agentId },
        },
      ]);
      expect(
        readFileSync(join(created.agent.linuxIdentity.workspace, "resumed-count.txt"), "utf8"),
      ).toBe("once\n");
      expect(JSON.stringify(requests.at(-1).input)).toContain("normal contents");
      expect(
        db.prepare("SELECT id FROM owner_agent_sessions WHERE agent_id=?").all(agentId),
      ).toEqual([{ id: oldRun.sessionId }]);
      expect(
        wire.some(
          (message) =>
            /agent\.run/.test(message.type) || "apiKey" in message || "sessionId" in message,
        ),
      ).toBe(false);
      expect(
        db.prepare("SELECT state,error_code FROM owner_agent_runs WHERE id=?").get(oldRun.runId),
      ).toEqual(interrupted);
      if (oldReceipt) {
        if (
          firstTool === "file" &&
          boundary === "receipt" &&
          (cause === "disconnect" || cause === "restart")
        ) {
          const original = wire.find(
            (message) =>
              message.type === "control.workspace.operation" &&
              message.operationId === oldReceipt.operationId,
          );
          const reconciliation = wire.find(
            (message) =>
              message.type === "control.workspace.reconcile" &&
              message.operations.some(
                (operation: { operationId: string }) =>
                  operation.operationId === oldReceipt.operationId,
              ),
          );
          const reconciled = wire.find(
            (message) =>
              message.type === "node.workspace.reconcile.result" &&
              message.requestId === reconciliation?.requestId,
          );
          expect(original).toBeDefined();
          expect(reconciliation).toBeDefined();
          expect(reconciliation.requestId).not.toBe(original.requestId);
          expect(oldReceipt.requestId).toBe(original.requestId);
          expect(reconciliation.operations).toContainEqual({
            agentId,
            operationId: oldReceipt.operationId,
            requestHash: workspaceReceiptRequestHash(agentId, original.operation),
          });
          expect(nodeReceipt.requestHash).toBe(
            workspaceReceiptRequestHash(agentId, original.operation),
          );
          expect(reconciled.receipts).toContainEqual({
            agentId,
            operationId: oldReceipt.operationId,
            result: { ...oldReceipt.result, revision: nodeReceipt.revision },
          });
          const corrections = z
            .object({ input: z.array(z.unknown()) })
            .array()
            .parse(requests)
            .flatMap((request) => fileModelCorrections(request.input));
          expect(corrections).toContainEqual(
            expect.objectContaining({
              operationId: oldReceipt.operationId,
              state: "succeeded",
              receipt: expect.objectContaining({
                operationId: oldReceipt.operationId,
                nodeRequestHash: nodeReceipt.requestHash,
                revision: nodeReceipt.revision,
              }),
            }),
          );
        }
        expect(
          wire.filter(
            (message) =>
              ["control.process.operation", "control.workspace.operation"].includes(message.type) &&
              message.operationId === oldReceipt.operationId,
          ),
        ).toHaveLength(1);
        expect(
          readFileSync(
            join(
              created.agent.linuxIdentity.workspace,
              firstTool === "command" ? "effect-count.txt" : "normal.txt",
            ),
            "utf8",
          ),
        ).toBe(firstTool === "command" ? "once\n" : "normal contents\nonce");
      }
    } finally {
      releaseRecovery();
      db?.close();
      await stopProcess(node);
      await stopProcess(control);
      for (const socket of sockets) socket.terminate();
      await Promise.all([
        new Promise<void>((done) => provider.close(() => done())),
        new Promise<void>((done) => proxyWs.close(() => done())),
        new Promise<void>((done) => proxyHttp.close(() => done())),
      ]);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  40_000,
);
