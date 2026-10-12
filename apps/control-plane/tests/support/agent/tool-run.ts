import Database from "better-sqlite3";
import { join } from "node:path";
import { queueUncertainOperationFacts } from "../../../src/runtime/recovery/context.js";
import { AgentSession } from "../../../src/runtime/session/service.js";
import {
  createControlPlane,
  type ControlPlaneOptions,
  type ControlPlane,
} from "../../../src/application.js";
import type { NodeSocket } from "../../../src/nodes/transport.js";

/** Tool/session tests pause the real scheduler before the external provider boundary.
 * Calls enter the public tool/session services directly, without a model transport. */
export interface TestRun {
  type: "test.run.started";
  requestId: string;
  runId: string;
  agentId: string;
  sessionId: string;
  actionScopeId: string;
  channelId: string;
  channelVisibility: "public" | "private";
  provider: string;
  modelId: string;
}
const fixtures = new WeakMap<
  ControlPlane,
  { path: string; sockets: Map<string, { sent: string[] }>; gates: Map<string, () => void> }
>();
const socketNodes = new WeakMap<object, string>();
export function toolTestApp(options: ControlPlaneOptions): ControlPlane {
  const path = join(options.dataDir!, "control-plane.sqlite");
  const sockets = new Map<string, { sent: string[] }>();
  const gates = new Map<string, () => void>();
  const app = createControlPlane(options, {
    beforeRunStart: async (runId) => {
      const db = new Database(path);
      try {
        const row = db
          .prepare(
            `SELECT r.id AS runId,r.agent_id AS agentId,r.node_id AS nodeId,s.id AS sessionId,
        r.delivery_id AS actionScopeId,d.channel_id AS channelId,c.visibility AS channelVisibility,a.provider,a.model_id AS modelId
        FROM owner_agent_runs r JOIN owner_agent_sessions s ON s.agent_id=r.agent_id JOIN owner_agents a ON a.id=r.agent_id
        JOIN owner_message_deliveries d ON d.id=r.delivery_id JOIN owner_channels c ON c.id=d.channel_id WHERE r.id=?`,
          )
          .get(runId) as TestRun & { nodeId: string };
        const { nodeId, ...run } = row;
        const waiting = new Promise<void>((resolve) => gates.set(runId, resolve));
        sockets
          .get(nodeId)
          ?.sent.push(JSON.stringify({ ...run, type: "test.run.started", requestId: runId }));
        await waiting;
      } finally {
        db.close();
      }
    },
  });
  const close = app.close.bind(app);
  app.close = async () => {
    const closed = close();
    for (const resolve of gates.values()) resolve();
    gates.clear();
    await closed;
  };
  fixtures.set(app, { path, sockets, gates });
  return app;
}
export function bindToolSocket(
  app: ControlPlane,
  nodeId: string,
  socket: { sent: string[] },
): void {
  fixtures.get(app)!.sockets.set(nodeId, socket);
  socketNodes.set(socket, nodeId);
}
export async function toolTestInput(
  app: ControlPlane,
  socket: NodeSocket & { sent: string[] },
  raw: string,
): Promise<void> {
  const input = JSON.parse(raw);
  const fixture = fixtures.get(app)!;
  if (input.type === "node.pair" || input.type === "node.authenticate")
    bindToolSocket(app, input.nodeId, socket);
  if (input.type === "session.read") {
    const db = new Database(fixture.path);
    try {
      queueUncertainOperationFacts(db, input.agentId, Date.now());
      const session = new AgentSession(db);
      const run = db
        .prepare("SELECT delivery_id FROM owner_agent_runs WHERE id=?")
        .get(input.runId) as { delivery_id: string };
      socket.sent.push(
        JSON.stringify({
          messages: [
            ...session.context(input.agentId),
            ...session.pendingCorrections(input.agentId, run.delivery_id),
          ],
        }),
      );
    } finally {
      db.close();
    }
  } else if (input.type === "tools.execute") {
    const result = await app.tools.execute(
      {
        runId: input.runId,
        nodeId: socketNodes.get(socket)!,
        agentId: input.agentId,
        toolCallId: input.toolCallId,
      },
      input.operation,
      input.input,
    );
    socket.send(
      JSON.stringify({
        type: "tools.result",
        requestId: input.requestId,
        runId: input.runId,
        toolCallId: input.toolCallId,
        ...result,
      }),
    );
  } else if (input.type === "session.append") {
    const db = new Database(fixture.path);
    try {
      const accepted = new AgentSession(db).append(
        { runId: input.runId, nodeId: socketNodes.get(socket)!, agentId: input.agentId },
        input.entry,
      );
      socket.sent.push(JSON.stringify({ type: "session.commit", accepted }));
    } finally {
      db.close();
    }
  } else if (input.type === "run.complete") {
    if (input.ok) app.chat.deliveries.completeAgentRun(input.runId, input.agentId);
    else {
      const db = new Database(fixture.path);
      try {
        db.prepare(
          "UPDATE owner_agent_runs SET state='failed',error_code=?,retry_at=?,completed_at=? WHERE id=? AND state='running'",
        ).run(input.code ?? "interrupted", Date.now(), Date.now(), input.runId);
      } finally {
        db.close();
      }
    }
    fixture.gates.get(input.runId)?.();
    fixture.gates.delete(input.runId);
    app.runs?.wake();
  } else await app.nodes.receive(socket, raw);
}
