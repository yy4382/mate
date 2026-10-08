import { WORKSPACE_WRITE_MAX_BYTES } from "@mate/protocol";
import { afterEach, expect, it } from "vitest";

import {
  cleanupAgentToolFixture,
  setup,
  authorizeModel,
  addAgent,
  waitForRuns,
} from "../support/agent/agent-tool-fixture.js";

it("executes file and process tools with defaults, receipts and domain-specific refusals", async () => {
  const { app, cookie, db, nodeId, socket } = await setup();
  const agentId = addAgent(app, nodeId, "File and process operator");
  const direct = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  await authorizeModel(app, cookie);
  const source = app.chat.channels.createChannel({
    name: "Trigger A",
    description: "",
    visibility: "public",
  });
  app.chat.channels.joinAgentToPublicChannel(agentId, source.id);
  app.chat.messages.createMessage({ channelId: source.id, text: "Write and publish a file." });
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
  ).toMatchObject({ ok: true, result: { content: "hello", totalBytes: 5, offset: 0 } });
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
  const privateChannel = app.chat.channels.createChannel({
    name: "Unrelated",
    description: "",
    visibility: "private",
  });
  expect(await call(12, "attachments.list", { conversationId: privateChannel.id })).toMatchObject({
    ok: false,
    error: expect.not.stringMatching(/Agent tool request was refused/),
  });
});

afterEach(cleanupAgentToolFixture);
