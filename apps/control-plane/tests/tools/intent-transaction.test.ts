import { toolTestInput } from "../support/agent/tool-run.js";

import { afterEach, expect, it } from "vitest";

import {
  cleanupAgentToolFixture,
  setup,
  authorizeModel,
  addAgent,
  waitForRuns,
} from "../support/agent/agent-tool-fixture.js";

it.each(["process.exec", "workspace.write", "attachments.publish"])(
  "%s commits its intent before network waiting, preserves dispatched effects, and refuses old-run continuation",
  async (name) => {
    const { app, cookie, db, nodeId, socket } = await setup();
    const agentId = addAgent(app, nodeId, "Late receipt");
    const direct = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
    await authorizeModel(app, cookie);
    app.chat.messages.createMessage({ channelId: direct.id, text: "Accept one operation." });
    const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
    const identity = {
      runId: run.runId,
      nodeId,
      agentId,
      toolCallId: `mate:${run.actionScopeId}:${"c".repeat(64)}:1`,
    };
    const input =
      name === "process.exec"
        ? { command: "printf late" }
        : name === "workspace.write"
          ? { path: "empty.txt", content: "" }
          : { conversationId: direct.id, path: "empty.txt" };
    let release!: () => Promise<void>;
    let dispatched!: () => void;
    const sent = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const version = { device: "1", inode: "2", size: 0, modifiedNs: "3", changedNs: "4" };
    let first = true;
    socket.onSend = (message) => {
      if (
        message.type !== "control.process.operation" &&
        message.type !== "control.workspace.operation"
      )
        return;
      const reply = async () => {
        await toolTestInput(
          app,
          socket,
          JSON.stringify(
            message.type === "control.process.operation"
              ? {
                  type: "node.process.operation.result",
                  requestId: message.requestId,
                  operationId: message.operationId,
                  agentId,
                  state: "succeeded",
                  receipt: { code: 0, stdout: "late" },
                }
              : {
                  type: "node.workspace.operation.result",
                  requestId: message.requestId,
                  operationId: message.operationId,
                  agentId,
                  ok: true,
                  result: {
                    code: 0,
                    stdout: JSON.stringify(
                      message.operation.kind === "workspace_stat"
                        ? { type: "file", size: 0, version }
                        : { written: true },
                    ),
                    stderr: "",
                    truncated: false,
                  },
                },
          ),
        );
      };
      if (!first) {
        void reply();
        return;
      }
      first = false;
      // This separate SQLite connection can see the intent only after the accepting transaction commits.
      if (name === "process.exec") {
        expect(
          db
            .prepare("SELECT state FROM owner_agent_process_operations WHERE operation_id=?")
            .get(message.operationId),
        ).toEqual({ state: "executing" });
      } else {
        expect(
          db
            .prepare("SELECT result_json FROM owner_agent_tool_actions WHERE action_id=?")
            .get(identity.toolCallId),
        ).toMatchObject({ result_json: expect.stringContaining('"state":"executing"') });
      }
      release = reply;
      dispatched();
    };
    const pending = app.tools.execute(identity, "tools.call", { name, input });
    await sent;
    // Ending the run while I/O waits also proves that no database lock is held over the network.
    await toolTestInput(
      app,
      socket,
      JSON.stringify({
        type: "run.complete",
        requestId: crypto.randomUUID(),
        runId: run.runId,
        agentId,
        ok: true,
      }),
    );
    expect(await app.tools.execute(identity, "tools.call", { name, input })).toEqual({
      ok: false,
      error: "Agent run is no longer active",
    });
    await release();
    if (name === "attachments.publish") {
      expect(await pending).toMatchObject({ ok: false });
      expect(app.attachments.listForOwner(direct.id)).toEqual([]);
    } else {
      expect(await pending).toMatchObject({
        ok: true,
        result:
          name === "process.exec"
            ? { state: "succeeded", receipt: { stdout: "late" } }
            : { written: true },
      });
    }
    const sentAfterReceipt = socket.sent.length;
    expect(await app.tools.execute(identity, "tools.call", { name, input })).toEqual({
      ok: false,
      error: "Agent run is no longer active",
    });
    expect(socket.sent).toHaveLength(sentAfterReceipt);
    const beforeNext = socket.sent.length;
    app.chat.messages.createMessage({
      channelId: direct.id,
      text: "Continue in the same session.",
    });
    const next = (await waitForRuns(socket, beforeNext, [agentId])).get(agentId)!;
    expect(next.runId).not.toBe(run.runId);
    expect(next.sessionId).toBe(run.sessionId);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM owner_agent_runs WHERE agent_id=? AND state='running'",
        )
        .get(agentId),
    ).toEqual({ count: 1 });
  },
);

it.each(["process.exec", "workspace.write", "attachments.publish"])(
  "%s never dispatches an intent whose final database commit fails",
  async (name) => {
    const { app, cookie, db, nodeId, socket } = await setup();
    const agentId = addAgent(app, nodeId, "Commit failure");
    const direct = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
    await authorizeModel(app, cookie);
    app.chat.messages.createMessage({
      channelId: direct.id,
      text: "Commit must precede dispatch.",
    });
    const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
    const identity = {
      runId: run.runId,
      nodeId,
      agentId,
      toolCallId: `mate:${run.actionScopeId}:${"d".repeat(64)}:1`,
    };
    const table =
      name === "process.exec" ? "owner_agent_process_operations" : "owner_agent_tool_actions";
    db.exec(`
    CREATE TABLE commit_failure(id TEXT REFERENCES owner_agents(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_tool_commit AFTER INSERT ON ${table}
    BEGIN INSERT INTO commit_failure VALUES('missing-agent'); END;
  `);
    const sent = socket.sent.length;
    const input =
      name === "process.exec"
        ? { command: "printf no" }
        : name === "workspace.write"
          ? { path: "no.txt", content: "no" }
          : { conversationId: direct.id, path: "no.txt" };
    expect(await app.tools.execute(identity, "tools.call", { name, input })).toMatchObject({
      ok: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.sent).toHaveLength(sent);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    expect(app.attachments.listForOwner(direct.id)).toEqual([]);
  },
);

it.each(["process.exec", "workspace.write", "attachments.publish"])(
  "%s rolls back its entire preparation if persistence fails after inserting the intent",
  async (name) => {
    const { app, cookie, db, nodeId, socket } = await setup();
    const agentId = addAgent(app, nodeId, "Preparation failure");
    const direct = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
    await authorizeModel(app, cookie);
    app.chat.messages.createMessage({ channelId: direct.id, text: "Preparation must be atomic." });
    const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
    const identity = {
      runId: run.runId,
      nodeId,
      agentId,
      toolCallId: `mate:${run.actionScopeId}:${"e".repeat(64)}:1`,
    };
    const failureTable =
      name === "attachments.publish" ? "owner_conversation_attachments" : "owner_agent_activity";
    db.exec(
      `CREATE TRIGGER fail_preparation BEFORE INSERT ON ${failureTable} ${name === "attachments.publish" ? "" : "WHEN NEW.kind='operation.started'"} BEGIN SELECT RAISE(ABORT, 'synthetic preparation failure'); END;`,
    );
    const sent = socket.sent.length;
    const input =
      name === "process.exec"
        ? { command: "printf no" }
        : name === "workspace.write"
          ? { path: "no.txt", content: "no" }
          : { conversationId: direct.id, path: "no.txt" };
    expect(await app.tools.execute(identity, "tools.call", { name, input })).toMatchObject({
      ok: false,
    });
    expect(socket.sent).toHaveLength(sent);
    const table =
      name === "process.exec" ? "owner_agent_process_operations" : "owner_agent_tool_actions";
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    expect(app.attachments.listForOwner(direct.id)).toEqual([]);
  },
);

afterEach(cleanupAgentToolFixture);
