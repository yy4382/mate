import { WORKSPACE_WRITE_MAX_BYTES } from "@mate/protocol";
import { expect, it } from "vitest";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { setup, authorizeModel, addAgent, waitForRuns } from "../helpers/agent-tool-fixture.js";

it("discovers and invokes conversation tools through the shared Agent tools interface", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = addAgent(app, nodeId, "Tool caller");
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await authorizeModel(app, cookie);
  app.chat.createMessage(direct.id, "Discover the available tools.");
  const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
  const identity = { runId: run.runId, nodeId, agentId, toolCallId: "shared-interface" };
  const listed = await app.tools.execute(identity, "tools.list", {});
  expect(listed).toMatchObject({
    ok: true,
    result: {
      tools: expect.arrayContaining([
        { name: "agents.list", description: expect.any(String) },
        { name: "workspace.read", description: expect.any(String) },
        { name: "attachments.publish", description: expect.any(String) },
        { name: "process.exec", description: expect.any(String) },
      ]),
    },
  });
  expect(
    await app.tools.execute(identity, "tools.describe", { name: "conversations.list" }),
  ).toMatchObject({
    ok: true,
    result: { name: "conversations.list", inputSchema: { type: "object" } },
  });
  expect(
    await app.tools.execute(identity, "tools.call", { name: "conversations.list", input: {} }),
  ).toMatchObject({
    ok: true,
    result: {
      conversations: expect.arrayContaining([
        {
          id: direct.id,
          name: direct.name,
          description: direct.description,
          visibility: "private",
          kind: "dm",
          member: true,
        },
      ]),
    },
  });
});

it("preserves the complete model-visible catalog and rejects invalid input before any effect", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = addAgent(app, nodeId, "Catalog reader");
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await authorizeModel(app, cookie);
  app.chat.createMessage(direct.id, "Inspect tools.");
  const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
  const identity = { runId: run.runId, nodeId, agentId, toolCallId: "catalog" };
  const surface = JSON.parse(
    readFileSync(new URL("../fixtures/agent-tool-surface.json", import.meta.url), "utf8"),
  ) as Array<{ name: string; description: string; inputSchema: unknown }>;
  expect(await app.tools.execute(identity, "tools.list", {})).toEqual({
    ok: true,
    result: { tools: surface.map(({ name, description }) => ({ name, description })) },
  });
  const messagesBefore = app.chat.listMessages(direct.id, undefined, 50);
  const sentBefore = socket.sent.length;
  for (const operation of surface) {
    expect(await app.tools.execute(identity, "tools.describe", { name: operation.name })).toEqual({
      ok: true,
      result: operation,
    });
    expect(
      await app.tools.execute(identity, "tools.call", {
        name: operation.name,
        input: { unexpected: true },
      }),
      operation.name,
    ).toEqual({ ok: false, error: "Invalid tool input" });
  }
  expect(await app.tools.execute(identity, "tools.call", { name: "toString", input: {} })).toEqual({
    ok: false,
    error: "Unknown operation",
  });
  expect(await app.tools.execute(identity, "tools.describe", { name: "__proto__" })).toEqual({
    ok: false,
    error: "Unknown operation",
  });
  expect(await app.tools.execute(identity, "tools.list", { extra: true })).toEqual({
    ok: false,
    error: "Invalid tool input",
  });
  expect(await app.tools.execute(identity, "tools.describe", {})).toEqual({
    ok: false,
    error: "Invalid tool input",
  });
  expect(
    await app.tools.execute(identity, "tools.call", { name: "agents.list", input: null }),
  ).toEqual({ ok: false, error: "Invalid tool input" });
  expect(socket.sent).toHaveLength(sentBefore);
  expect(app.chat.listMessages(direct.id, undefined, 50)).toEqual(messagesBefore);
});

it("executes file and process tools with defaults, receipts and domain-specific refusals", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = addAgent(app, nodeId, "File and process operator");
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await authorizeModel(app, cookie);
  const source = app.chat.createChannel({
    name: "Trigger A",
    description: "",
    visibility: "public",
  });
  app.chat.joinAgentToPublicChannel(agentId, source.id);
  app.chat.createMessage(source.id, "Write and publish a file.");
  const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
  const identity = { runId: run.runId, nodeId, agentId };
  const call = (id: number, name: string, input: Record<string, unknown>) =>
    app.tools.execute(
      { ...identity, toolCallId: `mate:${run.actionScopeId}:${"a".repeat(64)}:${id}` },
      "tools.call",
      { name, input },
    );
  // Removing both memberships is fixture setup, not a new leave-channel product feature.
  db.prepare("UPDATE owner_channel_memberships SET active=0 WHERE channel_id=?").run(source.id);
  expect(
    await call(30, "messages.send", { conversationId: direct.id, text: "Working in B" }),
  ).toMatchObject({ ok: true, result: { channelId: direct.id, text: "Working in B" } });
  let stored = "";
  const version = { device: "1", inode: "2", size: 5, modifiedNs: "3", changedNs: "4" };
  const requests: unknown[] = [];
  socket.onSend = (message) => {
    if (message.type === "control.process.operation") {
      requests.push(message.operation);
      queueMicrotask(
        () =>
          void app.nodes.receive(
            socket,
            JSON.stringify({
              type: "node.process.operation.result",
              requestId: message.requestId,
              operationId: message.operationId,
              agentId,
              state: "succeeded",
              receipt: { code: 0, stdout: "ran" },
            }),
          ),
      );
    }
    if (message.type !== "control.workspace.operation") return;
    requests.push(message.operation);
    const op = message.operation;
    let stdout = "{}";
    if (op.kind === "write") {
      stored = op.content;
      stdout = JSON.stringify({ written: true });
    }
    if (op.kind === "read") stdout = stored;
    if (op.kind === "workspace_stat") stdout = JSON.stringify({ type: "file", size: 5, version });
    if (op.kind === "workspace_read_chunk")
      stdout = JSON.stringify({
        base64: Buffer.from(stored).toString("base64"),
        offset: 0,
        totalBytes: 5,
        version,
      });
    if (op.kind === "workspace_list")
      stdout = JSON.stringify({
        entries: [{ name: "notes.txt", type: "file", size: 5 }],
        nextOffset: null,
      });
    queueMicrotask(
      () =>
        void app.nodes.receive(
          socket,
          JSON.stringify({
            type: "node.workspace.operation.result",
            requestId: message.requestId,
            operationId: message.operationId,
            agentId,
            ok: true,
            result: { code: 0, stdout, stderr: "", truncated: false },
          }),
        ),
    );
  };
  expect(await call(1, "workspace.write", { path: "notes.txt", content: "hello" })).toEqual({
    ok: true,
    result: { written: true },
  });
  expect(await call(1, "workspace.write", { path: "notes.txt", content: "hello" })).toEqual({
    ok: true,
    result: { written: true },
  });
  expect(requests).toHaveLength(1);
  expect(await call(1, "workspace.write", { path: "notes.txt", content: "other" })).toMatchObject({
    ok: false,
    error: expect.any(String),
  });
  expect(requests).toHaveLength(1);
  expect(await call(2, "workspace.read", { path: "notes.txt" })).toEqual({
    ok: true,
    result: { content: "hello" },
  });
  expect(await call(3, "workspace.list", { path: "." })).toMatchObject({
    ok: true,
    result: { entries: [{ name: "notes.txt" }] },
  });
  expect(requests.at(-1)).toEqual({ kind: "workspace_list", path: ".", offset: 0, limit: 32 });
  const published = await call(4, "attachments.publish", {
    conversationId: direct.id,
    path: "notes.txt",
  });
  expect(published).toMatchObject({
    ok: true,
    result: { filename: "notes.txt", size: 5, uploader: { kind: "agent", id: agentId } },
  });
  const sentAfterPublish = requests.length;
  expect(
    await call(4, "attachments.publish", { conversationId: direct.id, path: "notes.txt" }),
  ).toEqual(published);
  expect(requests).toHaveLength(sentAfterPublish);
  expect(
    await call(4, "attachments.publish", { conversationId: direct.id, path: "other.txt" }),
  ).toEqual({ ok: false, error: "操作 ID 已用于另一份文件。" });
  const attachment = app.attachments.listForOwner(direct.id)[0]!;
  expect(await call(5, "attachments.list", { conversationId: direct.id })).toEqual({
    ok: true,
    result: { attachments: [attachment] },
  });
  expect(
    await call(6, "attachments.read_chunk", {
      conversationId: direct.id,
      attachmentId: attachment.id,
      offset: 0,
    }),
  ).toMatchObject({ ok: true, result: { base64: "aGVsbG8=", totalBytes: 5, offset: 0 } });
  const executed = await call(7, "process.exec", { command: "printf ran" });
  expect(executed).toMatchObject({
    ok: true,
    result: { state: "succeeded", receipt: { code: 0, stdout: "ran" } },
  });
  expect(requests.at(-1)).toEqual({ kind: "exec", command: "printf ran", cwd: "." });
  const sentAfterExec = requests.length;
  expect(await call(7, "process.exec", { command: "printf ran" })).toEqual(executed);
  expect(await call(7, "process.exec", { command: "printf conflict" })).toEqual({
    ok: false,
    error: "Agent tool request was refused",
  });
  expect(requests).toHaveLength(sentAfterExec);
  expect(await call(8, "process.list", {})).toMatchObject({
    ok: true,
    result: { state: "succeeded" },
  });
  expect(requests.at(-1)).toEqual({ kind: "process.list" });
  const targetOperationId = "ba9a41b7-f577-4d5e-9376-ec48916a58b6";
  for (const [id, name] of [
    [9, "process.inspect"],
    [10, "process.stop"],
  ] as const) {
    expect(await call(id, name, { targetOperationId })).toMatchObject({
      ok: true,
      result: { state: "succeeded" },
    });
    expect(requests.at(-1)).toEqual({ kind: name, targetOperationId });
  }
  const successfulResponder = socket.onSend;
  socket.onSend = (message) => {
    if (message.type !== "control.workspace.operation") return;
    queueMicrotask(
      () =>
        void app.nodes.receive(
          socket,
          JSON.stringify({
            type: "node.workspace.operation.result",
            requestId: message.requestId,
            operationId: message.operationId,
            agentId,
            ok: false,
            error: "ENOENT: no such file",
          }),
        ),
    );
  };
  expect(await call(15, "workspace.read", { path: "missing.txt" })).toEqual({
    ok: false,
    error: "文件或目录不存在。",
  });
  socket.onSend = successfulResponder;
  const maximumBytes = Buffer.alloc(WORKSPACE_WRITE_MAX_BYTES, 0x61).toString("base64");
  expect(
    await call(20, "workspace.write_bytes", { path: "🧪".repeat(1365), base64: maximumBytes }),
  ).toEqual({ ok: true, result: {} });
  const beforeInvalidWrites = requests.length;
  expect(
    await call(21, "workspace.write_bytes", {
      path: "large.bin",
      base64: Buffer.alloc(WORKSPACE_WRITE_MAX_BYTES + 1).toString("base64"),
    }),
  ).toEqual({ ok: false, error: "Invalid tool input" });
  expect(
    await call(22, "workspace.write", {
      path: "escaped.txt",
      content: "\u0001".repeat(Math.floor(WORKSPACE_WRITE_MAX_BYTES / 2)),
    }),
  ).toEqual({ ok: false, error: "Invalid tool input" });
  expect(requests).toHaveLength(beforeInvalidWrites);
  expect(await call(11, "conversations.open_dm", { targetAgentId: agentId })).toEqual({
    ok: false,
    error: "An Agent cannot open a direct message with itself",
  });
  const privateChannel = app.chat.createChannel({
    name: "Unrelated",
    description: "",
    visibility: "private",
  });
  expect(await call(12, "attachments.list", { conversationId: privateChannel.id })).toMatchObject({
    ok: false,
    error: expect.not.stringMatching(/Agent tool request was refused/),
  });
});

it("maps storage exceptions once and rolls back conversation effects", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = addAgent(app, nodeId, "Storage failure");
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await authorizeModel(app, cookie);
  app.chat.createMessage(direct.id, "A storage failure must not half-send.");
  const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
  const identity = { runId: run.runId, nodeId, agentId, toolCallId: "storage-failure" };
  const before = app.chat.listMessages(direct.id, undefined, 50);
  db.exec(
    "CREATE TRIGGER tool_storage_failure BEFORE INSERT ON owner_agent_tool_actions BEGIN SELECT RAISE(ABORT, 'synthetic persistence failure'); END",
  );
  expect(
    await app.tools.execute(identity, "tools.call", {
      name: "messages.send",
      input: { conversationId: direct.id, text: "Must roll back" },
    }),
  ).toEqual({ ok: false, error: "Agent tool request was refused" });
  expect(app.chat.listMessages(direct.id, undefined, 50)).toEqual(before);
  db.exec("DROP TRIGGER tool_storage_failure");
  expect(
    await app.tools.execute(identity, "tools.call", {
      name: "messages.send",
      input: { conversationId: direct.id, text: "Must roll back" },
    }),
  ).toMatchObject({ ok: true, result: { text: "Must roll back" } });
});

it("refuses every registered operation and meta tool for ended, absent and another Agent's runs before any effect", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = addAgent(app, nodeId, "Current-run caller");
  const otherAgentId = addAgent(app, nodeId, "Other Agent");
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  const message = app.chat.createMessage(direct.id, "Exercise the complete registry.")!;
  await authorizeModel(app, cookie);
  const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
  const identity = {
    runId: run.runId,
    nodeId,
    agentId,
    toolCallId: `mate:${run.actionScopeId}:${"b".repeat(64)}:1`,
  };
  const listed = await app.tools.execute(identity, "tools.list", {});
  expect(listed.ok).toBe(true);
  if (!listed.ok) throw new Error(listed.error);
  const names = (listed.result as { tools: Array<{ name: string }> }).tools.map(
    (tool) => tool.name,
  );
  const id = message.id;
  const conversationId = direct.id;
  const task = { taskId: id, expectedVersion: 1 };
  const reminder = { reminderId: id, expectedVersion: 1 };
  const inputs: Record<string, Record<string, unknown>> = {
    "agents.list": {},
    "conversations.list": {},
    "conversations.read": { conversationId },
    "conversations.read_thread": { conversationId, rootId: id },
    "conversations.open_dm": { targetAgentId: otherAgentId },
    "conversations.join": { conversationId },
    "conversations.invite": { conversationId, agentId: otherAgentId },
    "attention.list": { conversationId },
    "attention.update": { conversationId, messageId: id, seen: true },
    "drafts.save": { conversationId, text: "Draft" },
    "drafts.review": { draftId: id, choice: "inspect" },
    "messages.send": { conversationId, text: "Must not be sent" },
    "tasks.create": { messageId: id },
    "tasks.claim_message": { messageId: id },
    "tasks.claim": task,
    "tasks.yield": task,
    "tasks.transfer": { ...task, agentId: otherAgentId },
    "tasks.update": { ...task, status: "done" },
    "tasks.review": { draftId: id, choice: "inspect" },
    "tasks.list": {},
    "reminders.create": { conversationId, text: "Reminder", dueAt: Date.now() + 60_000 },
    "reminders.reschedule": { ...reminder, dueAt: Date.now() + 60_000 },
    "reminders.cancel": reminder,
    "reminders.list": {},
    "workspace.list": { path: "." },
    "workspace.stat": { path: "." },
    "workspace.read": { path: "notes.txt" },
    "workspace.read_chunk": { path: "notes.txt", offset: 0 },
    "workspace.write": { path: "notes.txt", content: "No write" },
    "workspace.write_bytes": { path: "notes.txt", base64: "aGk=" },
    "workspace.edit": {
      path: "notes.txt",
      expectedHash: "a".repeat(64),
      oldText: "hi",
      newText: "bye",
    },
    "workspace.mkdir": { path: "dir" },
    "workspace.move": { path: "notes.txt", destination: "other.txt" },
    "workspace.remove": { path: "notes.txt" },
    "attachments.list": { conversationId },
    "attachments.read_chunk": { conversationId, attachmentId: id, offset: 0 },
    "attachments.publish": { conversationId, path: "notes.txt" },
    "process.exec": { command: "printf no" },
    "process.list": {},
    "process.inspect": { targetOperationId: id },
    "process.stop": { targetOperationId: id },
  };
  expect(Object.keys(inputs).sort()).toEqual([...names].sort());
  for (const name of names) {
    const described = await app.tools.execute(identity, "tools.describe", { name });
    if (!described.ok) throw new Error(described.error);
    const { inputSchema } = described.result as { inputSchema: z.core.JSONSchema.JSONSchema };
    expect(z.fromJSONSchema(inputSchema).safeParse(inputs[name]).success, name).toBe(true);
  }
  // A successful synchronous action also supplies a cached result which old runs must not receive.
  const cached = await app.tools.execute(identity, "tools.call", {
    name: "messages.send",
    input: inputs["messages.send"],
  });
  expect(cached).toMatchObject({ ok: true });
  for (const candidate of [
    { ...identity, agentId: otherAgentId },
    { ...identity, runId: "0f3a72f0-7b96-4110-b9bb-6892a477aee8" },
    identity,
  ]) {
    if (candidate === identity) {
      await app.nodes.receive(
        socket,
        JSON.stringify({
          type: "node.agent.run.result",
          requestId: crypto.randomUUID(),
          runId: run.runId,
          agentId,
          ok: true,
        }),
      );
    }
    const before = db.serialize();
    const sent = socket.sent.length;
    for (const name of names) {
      expect(
        await app.tools.execute(candidate, "tools.call", { name, input: inputs[name] }),
        name,
      ).toEqual({ ok: false, error: "Agent run is no longer active" });
      expect(await app.tools.execute(candidate, "tools.describe", { name }), name).toEqual({
        ok: false,
        error: "Agent run is no longer active",
      });
    }
    expect(await app.tools.execute(candidate, "tools.list", {})).toEqual({
      ok: false,
      error: "Agent run is no longer active",
    });
    expect(socket.sent).toHaveLength(sent);
    expect(db.serialize()).toEqual(before);
  }
});

it.each(["process.exec", "workspace.write", "attachments.publish"])(
  "%s commits its intent before network waiting and keeps a late receipt without granting the old run new actions",
  async (name) => {
    const { app, cookie, db, nodeId, socket } = await setup();
    const agentId = addAgent(app, nodeId, "Late receipt");
    const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
    await authorizeModel(app, cookie);
    app.chat.createMessage(direct.id, "Accept one operation.");
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
        await app.nodes.receive(
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
    await app.nodes.receive(
      socket,
      JSON.stringify({
        type: "node.agent.run.result",
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
    expect(await pending).toMatchObject({
      ok: true,
      result:
        name === "attachments.publish"
          ? { size: 0 }
          : name === "process.exec"
            ? { state: "succeeded", receipt: { stdout: "late" } }
            : { written: true },
    });
    if (name === "attachments.publish")
      expect(app.attachments.listForOwner(direct.id)).toHaveLength(1);
    const sentAfterReceipt = socket.sent.length;
    expect(await app.tools.execute(identity, "tools.call", { name, input })).toEqual({
      ok: false,
      error: "Agent run is no longer active",
    });
    expect(socket.sent).toHaveLength(sentAfterReceipt);
    const beforeNext = socket.sent.length;
    app.chat.createMessage(direct.id, "Continue in the same session.");
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
    const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
    await authorizeModel(app, cookie);
    app.chat.createMessage(direct.id, "Commit must precede dispatch.");
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
    const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
    await authorizeModel(app, cookie);
    app.chat.createMessage(direct.id, "Preparation must be atomic.");
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

it("rolls back all body-presentation changes when a synchronous read fails, and refuses reads after the run ends", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = addAgent(app, nodeId, "Atomic reader");
  const direct = app.chat.getOrCreateAgentDirectChannel(agentId)!;
  await authorizeModel(app, cookie);
  app.chat.createMessage(direct.id, "Start reading.");
  const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
  const first = app.chat.createMessage(direct.id, "First unread body")!;
  const second = app.chat.createMessage(direct.id, "Second unread body")!;
  const identity = { runId: run.runId, nodeId, agentId, toolCallId: "atomic-read" };
  const attention = () =>
    app.tools.execute(identity, "tools.call", {
      name: "attention.list",
      input: { conversationId: direct.id },
    });
  const before = await attention();
  expect(before).toMatchObject({
    ok: true,
    result: {
      items: expect.arrayContaining([
        expect.objectContaining({ messageId: first.id, unread: 1, seen: 0, presented: 0 }),
        expect.objectContaining({ messageId: second.id, unread: 1, seen: 0, presented: 0 }),
      ]),
    },
  });
  db.exec(`CREATE TRIGGER fail_read AFTER UPDATE ON owner_agent_message_attention
    WHEN NEW.message_id='${second.id}' AND NEW.presented=1
    BEGIN SELECT RAISE(ABORT, 'synthetic read failure'); END;`);
  const read = () =>
    app.tools.execute(identity, "tools.call", {
      name: "conversations.read",
      input: { conversationId: direct.id },
    });
  expect(await read()).toEqual({ ok: false, error: "Agent tool request was refused" });
  expect(await attention()).toEqual(before);
  db.exec("DROP TRIGGER fail_read");
  expect(await read()).toMatchObject({ ok: true });
  expect(await attention()).toMatchObject({
    ok: true,
    result: {
      items: expect.arrayContaining([
        expect.objectContaining({ messageId: first.id, unread: 1, seen: 0, presented: 1 }),
        expect.objectContaining({ messageId: second.id, unread: 1, seen: 0, presented: 1 }),
      ]),
    },
  });
  await app.nodes.receive(
    socket,
    JSON.stringify({
      type: "node.agent.run.result",
      requestId: crypto.randomUUID(),
      runId: run.runId,
      agentId,
      ok: true,
    }),
  );
  app.runs?.close();
  await Promise.resolve();
  const after = db.serialize();
  expect(await read()).toEqual({ ok: false, error: "Agent run is no longer active" });
  expect(db.serialize()).toEqual(after);
});

it("admits only prepared Agents and lifecycle requests cannot change their node or regress their preparation", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = crypto.randomUUID();
  const request = {
    id: agentId,
    nodeId,
    name: "Preparation lifecycle",
    role: "Waits for workspace",
    description: "Synthetic fixture",
    model: { provider: "openai" as const, id: "gpt-4.1" },
  };
  app.agents.prepare(request);
  await authorizeModel(app, cookie);
  app.runs?.wake();
  expect(app.chat.getOrCreateAgentDirectChannel(agentId)).toBeUndefined();
  expect(
    socket.sent
      .map((text) => JSON.parse(text))
      .filter((message) => message.type === "control.agent.run"),
  ).toEqual([]);
  expect(
    await app.tools.execute(
      { agentId, nodeId, runId: crypto.randomUUID(), toolCallId: "not-prepared" },
      "tools.list",
      {},
    ),
  ).toEqual({ ok: false, error: "Agent run is no longer active" });
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
  app.chat.createMessage(direct.id, "Now the workspace is ready.");
  const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
  app.agents.updateStage(agentId, "preparing_workspace");
  app.agents.fail(agentId, "Late preparation failure");
  expect(() => app.agents.prepare({ ...request, nodeId: crypto.randomUUID() })).toThrow();
  expect(app.agents.get(agentId)).toMatchObject({ stage: "complete", nodeId });
  expect(
    await app.tools.execute(
      { agentId, nodeId, runId: run.runId, toolCallId: "ready" },
      "tools.list",
      {},
    ),
  ).toMatchObject({ ok: true });
});
