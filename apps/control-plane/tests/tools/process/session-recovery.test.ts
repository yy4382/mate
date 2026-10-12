import { toolTestApp, toolTestInput } from "../../support/agent/tool-run.js";

import { randomUUID, sign } from "node:crypto";

import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { deriveAgentProcessOperationId } from "../../../src/runtime/processes/operations.js";

import {
  fixtures,
  cleanupFixture,
  FakeNodeSocket,
  createProcessToolFixture,
  waitForRun,
} from "../../support/agent/process-tool-fixture.js";
afterEach(cleanupFixture);

it.each(["restart", "reconnect", "conflicting receipt", "malformed workspace"])(
  "continues the same session without new input after %s and presents uncertainty first",
  async (mode) => {
    const { app, cookie, db, nodeId, socket, keyPair } = await createProcessToolFixture();
    const agentId = randomUUID();
    app.agents.prepare({
      id: agentId,
      nodeId,
      name: "Missing receipt",
      role: "Process recovery",
      description: "Committed intent without dispatch",
      model: { provider: "openai", id: "gpt-4.1" },
    });
    app.agents.complete(
      agentId,
      {
        username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
        uid: 23003,
        gid: 23003,
        workspace: `/var/lib/mate/agents/${agentId}`,
        workspaceMarker: "a".repeat(64),
      },
      app.chat,
    );
    const direct = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
    await app.http.request("/api/owner/model-credentials/openai", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "synthetic-key" }),
    });
    const start = socket.sent.length;
    app.chat.messages.createMessage({ channelId: direct.id, text: "Run a command once." });
    const run = await waitForRun(socket, start);
    const actionId = `mate:${run.actionScopeId}:${"f".repeat(64)}:1`;
    const operationId = deriveAgentProcessOperationId(agentId, actionId);
    const at = Date.now();
    db.prepare(
      `INSERT INTO owner_agent_process_operations(
    operation_id,run_id,agent_id,node_id,
    request_hash,request_json,state,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,'executing',?,?)`,
    ).run(
      operationId,
      run.runId,
      agentId,
      nodeId,
      "f".repeat(64),
      JSON.stringify({
        actionScopeId: run.actionScopeId,
        stableActionId: actionId,
        nodeId,
        agentId,
        operation: { kind: "exec", command: "true" },
      }),
      at,
      at,
    );
    if (mode === "malformed workspace")
      db.prepare(
        `INSERT INTO owner_agent_tool_actions
    (session_id,action_id,agent_id,operation,request_hash,result_json,created_at)
    VALUES(?,?,?,'workspace.write_file',?,'{',?)`,
      ).run(run.sessionId, "broken-file-action", agentId, "b".repeat(64), at);
    if (mode === "reconnect") app.nodes.close(socket);
    else app.runs?.close(); // The original control-plane process crashed before dispatch.
    const directory = fixtures.at(-1)!.directory;
    const restarted =
      mode === "reconnect"
        ? app
        : toolTestApp({
            dataDir: join(directory, "control-plane"),
            passwordFile: join(directory, "owner-password"),
          });
    try {
      const recovered = new FakeNodeSocket();
      restarted.nodes.open(recovered);
      const challenge = JSON.parse(recovered.sent[0]!) as { nonce: string };
      await toolTestInput(
        restarted,
        recovered,
        JSON.stringify({
          type: "node.authenticate",
          requestId: randomUUID(),
          nodeId,
          signature: sign(null, Buffer.from(challenge.nonce), keyPair.privateKey).toString(
            "base64url",
          ),
        }),
      );
      const reconcile = recovered.sent
        .map((text) => JSON.parse(text) as Record<string, unknown>)
        .find((message) => message.type === "control.process.reconcile")!;
      expect(reconcile).toMatchObject({ operations: [{ operationId, agentId }] });
      expect(recovered.sent.some((text) => text.includes('"type":"test.run.started"'))).toBe(false);
      await toolTestInput(
        restarted,
        recovered,
        JSON.stringify({
          type: "node.process.reconcile.result",
          requestId: reconcile.requestId,
          receipts:
            mode === "conflicting receipt"
              ? [
                  {
                    operationId,
                    agentId: randomUUID(),
                    state: "succeeded",
                    receipt: { code: 0 },
                    revision: 2,
                  },
                ]
              : [],
        }),
      );
      expect(
        db
          .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
          .get(operationId),
      ).toEqual({ state: "unknown" });

      expect(
        db.prepare("SELECT error_code FROM owner_agent_runs WHERE id=?").get(run.runId),
      ).toEqual({ error_code: "interrupted" });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM owner_agent_activity WHERE kind='run.interrupted' AND reference_id=?",
          )
          .get(run.runId),
      ).toEqual({ count: 1 });
      const next = await waitForRun(recovered, 0);
      expect(next.runId).not.toBe(run.runId);
      expect(next.sessionId).toBe(run.sessionId);
      await toolTestInput(
        restarted,
        recovered,
        JSON.stringify({
          type: "session.read",
          requestId: randomUUID(),
          runId: next.runId,
          agentId,
          cursor: 0,
          limit: 100,
        }),
      );
      const context = JSON.parse(recovered.sent.at(-1)!);
      expect(JSON.stringify(context.messages)).toContain(operationId);
      expect(JSON.stringify(context.messages)).toContain(
        mode === "conflicting receipt"
          ? "node_receipt_identity_conflict"
          : "no_durable_node_receipt",
      );
      expect(JSON.stringify(context.messages)).toContain("仍可能运行");
      expect(JSON.stringify(context.messages)).toContain("true");
      expect(
        recovered.sent.some((text) => JSON.parse(text).type === "control.process.operation"),
      ).toBe(false);
      if (mode === "malformed workspace") {
        expect(JSON.stringify(context.messages)).toContain("broken-file-action");
        expect(JSON.stringify(context.messages)).toContain("historical_information_unreadable");
      }
      const corrections = context.messages.filter(
        (entry: { message: { content: unknown } }) =>
          typeof entry.message.content === "string" &&
          entry.message.content.startsWith("Mate 收据更正："),
      );
      for (const entry of corrections)
        await toolTestInput(
          restarted,
          recovered,
          JSON.stringify({
            type: "session.append",
            requestId: entry.id,
            runId: next.runId,
            agentId,
            entry: { kind: "message", id: entry.id, message: entry.message },
          }),
        );
      await toolTestInput(
        restarted,
        recovered,
        JSON.stringify({
          type: "session.read",
          requestId: randomUUID(),
          runId: next.runId,
          agentId,
          cursor: 0,
          limit: 100,
        }),
      );
      const consumed = JSON.parse(recovered.sent.at(-1)!);
      expect(
        consumed.messages.filter((entry: { id: string }) =>
          corrections.some((fact: { id: string }) => fact.id === entry.id),
        ),
      ).toHaveLength(corrections.length);
      expect(
        consumed.messages.filter(
          (entry: { id: string; pending?: boolean }) =>
            entry.pending && corrections.some((fact: { id: string }) => fact.id === entry.id),
        ),
      ).toHaveLength(0);
    } finally {
      await restarted.close();
    }
  },
);
