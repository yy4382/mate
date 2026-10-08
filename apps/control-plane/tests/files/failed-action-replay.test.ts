import { toolTestApp, toolTestInput } from "../support/agent/tool-run.js";

import { randomUUID, sign } from "node:crypto";

import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  password,
  fixtures,
  cleanupFixture,
  FakeNodeSocket,
  setup,
  waitForRun,
  callAgentTool,
  stableToolActionId,
} from "../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

it.each(["legacy", "structured"])(
  "replays a confirmed failed file action as the same error after control-plane restart (%s)",
  async (mode) => {
    const { app, cookie, db, nodeId, socket, keyPair } = await setup();
    const agentId = randomUUID();
    app.agents.prepare({
      id: agentId,
      nodeId,
      name: "Failure replay",
      role: "File recovery",
      description: "Durable failed receipt fixture",
      model: { provider: "openai", id: "gpt-4.1" },
    });
    app.agents.complete(
      agentId,
      {
        username: "mate-node-account",
        uid: 23001,
        gid: 23001,
        workspace: `/var/lib/mate/agents/${agentId}`,
        workspaceMarker: "a".repeat(64),
      },
      app.chat,
    );
    const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
    await app.http.request("/api/owner/model-credentials/openai", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "synthetic-key" }),
    });
    const start = socket.sent.length;
    app.chat.createMessage(direct.id, "Attempt one file action.");
    const firstRun = await waitForRun(socket, start);
    const input = { name: "workspace.write", input: { path: "protected.txt", content: "no" } },
      actionId = stableToolActionId(firstRun.actionScopeId, input);
    let executions = 0;
    let failureReceipt: unknown;
    socket.onWorkspaceOperation = async (request) => {
      executions++;
      failureReceipt = {
        type: "node.workspace.operation.result",
        requestId: request.requestId,
        operationId: request.operationId,
        agentId,
        ok: true,
        result: {
          code: 9,
          stdout: "",
          stderr:
            mode === "structured"
              ? "operation_unknown: ENOENT misleading"
              : "permission_denied: file is protected",
          ...(mode === "structured" ? { errorCode: "permission_denied" } : {}),
          truncated: false,
          revision: 1,
        },
      };
      await toolTestInput(app, socket, JSON.stringify(failureReceipt));
    };
    const original = await callAgentTool(app, socket, firstRun, actionId, "tools.call", input);
    expect(original).toMatchObject({ ok: false, error: expect.stringContaining("9") });
    expect(original.error).toContain("没有读取此文件的权限");
    const savedResult = db
      .prepare("SELECT result_json FROM owner_agent_tool_actions WHERE action_id=?")
      .get(actionId);
    await toolTestInput(app, socket, JSON.stringify(failureReceipt));
    expect(
      db
        .prepare("SELECT result_json FROM owner_agent_tool_actions WHERE action_id=?")
        .get(actionId),
    ).toEqual(savedResult);
    expect(executions).toBe(1);
    app.runs?.close();
    app.nodes.close(socket);
    const directory = fixtures.at(-1)!.directory;
    const restarted = toolTestApp({
      dataDir: join(directory, "control-plane"),
      passwordFile: join(directory, "owner-password"),
    });
    try {
      const recovered = new FakeNodeSocket();
      recovered.onWorkspaceOperation = () => {
        executions++;
      };
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
      const reconciliation = recovered.sent
        .map((text) => JSON.parse(text))
        .find((message) => message.type === "control.workspace.reconcile");
      await toolTestInput(
        restarted,
        recovered,
        JSON.stringify({
          type: "node.workspace.reconcile.result",
          requestId: reconciliation.requestId,
          receipts: [],
        }),
      );
      const retryRun = await waitForRun(recovered, 0);
      expect(retryRun.runId).not.toBe(firstRun.runId);
      expect(retryRun.actionScopeId).toBe(firstRun.actionScopeId);
      const replay = await callAgentTool(
        restarted,
        recovered,
        retryRun,
        actionId,
        "tools.call",
        input,
      );
      expect(replay).toMatchObject({ ok: false, error: original.error });
      expect(
        db
          .prepare("SELECT result_json FROM owner_agent_tool_actions WHERE action_id=?")
          .get(actionId),
      ).toEqual(savedResult);
      expect(executions).toBe(1);
      expect(
        db
          .prepare(
            "SELECT json_extract(result_json,'$.state') AS state FROM owner_agent_tool_actions WHERE action_id=?",
          )
          .get(actionId),
      ).toEqual({ state: "failed" });

      const operationId = reconciliation.operations[0].operationId;
      const late = async (
        revision: number | undefined,
        code: number,
        stdout: string,
        stderr: string,
      ) =>
        restarted.nodes.receive(
          recovered,
          JSON.stringify({
            type: "node.workspace.operation.result",
            requestId: randomUUID(),
            operationId,
            agentId,
            ok: true,
            result: { code, stdout, stderr, truncated: false, revision },
          }),
        );
      await late(4, 1, "", "operation_unknown: result unavailable");
      await late(undefined, 1, "", "operation_unknown: no durable receipt");
      await late(4, 0, '{"written":true}', "");
      await late(2, 0, '{"written":true}', "");
      const stale = await callAgentTool(
        restarted,
        recovered,
        retryRun,
        actionId,
        "tools.call",
        input,
      );
      expect(stale).toMatchObject({ ok: false, error: expect.stringContaining("尚未确认") });
      await late(5, 0, '{"written":true}', "");
      expect(
        await callAgentTool(restarted, recovered, retryRun, actionId, "tools.call", input),
      ).toMatchObject({ ok: true, result: { written: true } });
      await late(5, 0, '{"written":false}', "");
      await toolTestInput(
        restarted,
        recovered,
        JSON.stringify({
          type: "session.read",
          requestId: randomUUID(),
          runId: retryRun.runId,
          agentId,
          cursor: 0,
          limit: 100,
        }),
      );
      const facts = JSON.parse(recovered.sent.at(-1)!)
        .messages.filter(
          (entry: { message: { content?: unknown } }) =>
            typeof entry.message.content === "string" &&
            entry.message.content.startsWith("Mate 收据更正："),
        )
        .map((entry: { message: { content: string } }) =>
          JSON.parse(entry.message.content.slice("Mate 收据更正：".length)),
        );
      expect(
        facts.some(
          (fact: { reason?: string; request?: unknown }) =>
            fact.reason === "operation_result_conflict" &&
            JSON.stringify(fact.request).includes("protected.txt"),
        ),
      ).toBe(true);
      expect(executions).toBe(1);
    } finally {
      restarted.close();
    }
  },
);
