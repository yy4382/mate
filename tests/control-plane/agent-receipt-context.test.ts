import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { WebSocket, WebSocketServer } from "ws";
import { expect, it } from "vitest";
import {
  eventually,
  login,
  ownerPassword,
  startControlPlane,
  startNode,
  stopProcess,
  type ProcessOutput,
} from "../helpers/run-services.js";

it("preserves the observed unknown result and appends a late receipt through another channel when the DM is archived", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-receipt-context-"));
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, "owner-password"), ownerPassword, { mode: 0o600 });
  let control: ProcessOutput | undefined,
    node: ProcessOutput | undefined,
    db: Database.Database | undefined;
  let origin = "",
    held: { socket: WebSocket; data: string } | undefined,
    writes = 0;
  const http = createServer(),
    ws = new WebSocketServer({ noServer: true }),
    sockets = new Set<WebSocket>();
  http.on("upgrade", (request, network, head) =>
    ws.handleUpgrade(request, network, head, (downstream) => {
      const upstream = new WebSocket(origin.replace(/^http/, "ws") + "/api/nodes/connect");
      sockets.add(downstream);
      sockets.add(upstream);
      downstream.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === "node.workspace.operation.result" && !held) {
          held = { socket: upstream, data: data.toString() };
          return;
        }
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
      });
      upstream.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === "control.workspace.operation" && message.operation?.kind === "write")
          writes++;
        if (downstream.readyState === WebSocket.OPEN) downstream.send(data);
      });
      downstream.on("close", () => upstream.terminate());
      upstream.on("close", () => downstream.terminate());
      upstream.on("error", () => upstream.terminate());
    }),
  );
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  try {
    control = startControlPlane(directory, 150);
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
    const token = await api("/api/owner/nodes/pairing-tokens");
    node = startNode({
      origin: `http://127.0.0.1:${(http.address() as { port: number }).port}`,
      nodeData: join(directory, "node"),
      workspaceRoot: join(directory, "workspaces"),
      pairingToken: token.pairingToken,
      modelWorkerEntry: resolve("tests/fixtures/direct-message-model-worker.mjs"),
    });
    const nodeId = (await node.waitFor(/MATE_NODE_PAIRED ([0-9a-f-]+)/))[1]!;
    const agentId = randomUUID();
    const created = await api("/api/owner/agents", {
      id: agentId,
      nodeId,
      name: "Receipt",
      role: "Synthetic",
      description: "Synthetic",
      model: { provider: "openai", id: "gpt-4o-mini" },
    });
    const dm = (await api(`/api/owner/agents/${agentId}/direct-channel`)).channel.id;
    await api(
      "/api/owner/model-credentials/openai",
      { apiKey: "synthetic-key-workspace-recovery" },
      "PUT",
    );
    db = new Database(join(directory, "control-plane-data", "control-plane.sqlite"), {
      readonly: true,
    });
    const complete = async (n: number) =>
      eventually(
        () =>
          (
            db!
              .prepare(
                "SELECT count(*) AS n FROM owner_agent_runs WHERE agent_id=? AND state='completed'",
              )
              .get(agentId) as { n: number }
          ).n === n
            ? true
            : undefined,
        `completed ${n}`,
      );
    await api(`/api/owner/channels/${dm}/messages`, { text: "Write once" });
    await complete(1);
    expect(held).toBeDefined();
    expect(JSON.parse(held!.data)).toMatchObject({ ok: true });
    expect(readFileSync(join(created.agent.linuxIdentity.workspace, "memo.txt"), "utf8")).toBe(
      "once",
    );
    const observed = db
      .prepare(
        "SELECT id,payload_json FROM owner_agent_session_records WHERE agent_id=? AND json_extract(payload_json,'$.message.role')='toolResult'",
      )
      .get(agentId) as { id: string; payload_json: string };
    expect(JSON.parse(observed.payload_json).message.isError).toBe(true);
    await api(`/api/owner/channels/${dm}`, { archived: true }, "PATCH");
    held!.socket.send(held!.data);
    await eventually(
      () =>
        (
          db!
            .prepare("SELECT count(*) AS n FROM owner_agent_session_updates WHERE agent_id=?")
            .get(agentId) as { n: number }
        ).n === 1
          ? true
          : undefined,
      "independent correction outbox",
    );
    held!.socket.send(held!.data);
    const room = await api("/api/owner/channels", {
      name: "Recovery",
      description: "Synthetic",
      visibility: "public",
    });
    await api(`/api/owner/channels/${room.id}/invitations`, { agentId });
    await api(`/api/owner/channels/${room.id}/messages`, { text: "Continue elsewhere" });
    await complete(2);
    expect(
      db
        .prepare("SELECT payload_json FROM owner_agent_session_records WHERE id=?")
        .get(observed.id),
    ).toEqual({ payload_json: observed.payload_json });
    const corrections = db
      .prepare(
        "SELECT payload_json FROM owner_agent_session_records WHERE agent_id=? AND json_extract(payload_json,'$.message.content') LIKE '%Mate 收据更正%'",
      )
      .all(agentId) as Array<{ payload_json: string }>;
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.payload_json).toContain("succeeded");
    expect(corrections[0]!.payload_json).toContain("workspace.write");
    expect(writes).toBe(1);
  } finally {
    db?.close();
    await stopProcess(node);
    await stopProcess(control);
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((done) => ws.close(() => done()));
    await new Promise<void>((done) => http.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
