import { toolTestInput } from "../../support/agent/tool-run.js";

import { randomUUID } from "node:crypto";

import { afterEach, expect, it } from "vitest";

import {
  cleanupFixture,
  createConversationFixture,
  waitForRun,
  callAgentTool,
  stableToolActionId,
} from "../../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

it("publishes Agent workspace files to a joined conversation in bounded chunks and rechecks ACL before replay", async () => {
  const { app, cookie, db, nodeId, socket } = await createConversationFixture();
  const agentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Attachment publisher",
    role: "Shares a workspace file",
    description: "Synthetic attachment fixture.",
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
  const channel = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  const destination = app.chat.channels.createChannel({
    name: "Shared research",
    description: "Agent has explicitly joined this conversation.",
    visibility: "public",
  });
  expect(app.chat.channels.inviteAgentToChannel(destination.id, agentId)).toBe(true);
  db.prepare(
    `UPDATE owner_channel_memberships SET active=0
     WHERE channel_id=? AND principal_kind='human' AND principal_id='owner'`,
  ).run(destination.id);
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.messages.createMessage({
    channelId: channel.id,
    text: "Publish a note from the workspace.",
  });
  const run = await waitForRun(socket, runStart),
    requests: Array<Record<string, unknown>> = [],
    version = { device: "1", inode: "2", size: 5, modifiedNs: "3", changedNs: "4" };
  socket.onWorkspaceOperation = async (message) => {
    requests.push(message);
    const operation = message.operation as { kind: string; offset?: number };
    const result =
      operation.kind === "workspace_stat"
        ? {
            code: 0,
            stdout: JSON.stringify({ type: "file", size: 5, version }),
            stderr: "",
            truncated: false,
          }
        : {
            code: 0,
            stdout: JSON.stringify({
              offset: operation.offset,
              totalBytes: 5,
              base64: "aGVsbG8=",
              version,
            }),
            stderr: "",
            truncated: false,
          };
    await toolTestInput(
      app,
      socket,
      JSON.stringify({
        type: "node.workspace.operation.result",
        requestId: message.requestId,
        operationId: message.operationId,
        agentId,
        ok: true,
        result,
      }),
    );
  };

  const unjoined = app.chat.channels.createChannel({
    name: "Not joined",
    description: "The Agent must not publish here.",
    visibility: "public",
  });
  const input = {
    name: "attachments.publish",
    input: { conversationId: destination.id, path: "notes.txt", filename: "共享笔记.txt" },
  };
  const actionId = stableToolActionId(run.actionScopeId, input);
  const deniedInput = {
    name: "attachments.publish",
    input: { conversationId: unjoined.id, path: "notes.txt", filename: "不应发布.txt" },
  };
  const deniedActionId = stableToolActionId(run.actionScopeId, deniedInput);
  const denied = await callAgentTool(app, socket, run, deniedActionId, "tools.call", deniedInput);
  expect(denied.ok).toBe(false);
  expect(requests).toHaveLength(0);
  const attempts = await Promise.all([
    callAgentTool(app, socket, run, actionId, "tools.call", input),
    callAgentTool(app, socket, run, actionId, "tools.call", input),
  ]);
  const published = attempts.find((attempt) => attempt.ok)!;
  expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(1);
  db.prepare(
    `UPDATE owner_channel_memberships SET active=1
     WHERE channel_id=? AND principal_kind='human' AND principal_id='owner'`,
  ).run(destination.id);
  expect(published).toMatchObject({
    ok: true,
    result: { filename: "共享笔记.txt", size: 5, uploader: { kind: "agent", id: agentId } },
  });
  expect(requests.map((request) => (request.operation as { kind: string }).kind)).toEqual([
    "workspace_stat",
    "workspace_read_chunk",
    "workspace_stat",
  ]);
  expect(requests.every((request) => request.mode === "agent_publish")).toBe(true);
  expect((requests[1]?.operation as { length: number }).length).toBeLessThanOrEqual(8192);

  const sourceList = await app.http.request(`/api/owner/channels/${channel.id}/attachments`, {
    headers: { cookie },
  });
  expect(((await sourceList.json()) as { attachments: unknown[] }).attachments).toEqual([]);
  const ownerList = await app.http.request(`/api/owner/channels/${destination.id}/attachments`, {
    headers: { cookie },
  });
  expect(ownerList.status).toBe(200);
  const items = (await ownerList.json()) as {
    attachments: Array<{ id: string; filename: string }>;
  };
  expect(items.attachments).toMatchObject([{ filename: "共享笔记.txt" }]);
  const content = await app.http.request(
    `/api/owner/channels/${destination.id}/attachments/${items.attachments[0]!.id}/content`,
    { headers: { cookie } },
  );
  expect(content.status).toBe(200);
  expect(await content.text()).toBe("hello");

  const replay = await callAgentTool(app, socket, run, actionId, "tools.call", input);
  expect(replay.result).toEqual(published.result);
  expect(requests).toHaveLength(3);
  db.prepare(
    `UPDATE owner_channel_memberships SET active=0 WHERE channel_id=? AND principal_kind='agent' AND principal_id=?`,
  ).run(destination.id, agentId);
  const revokedReplay = await callAgentTool(app, socket, run, actionId, "tools.call", input);
  expect(revokedReplay.ok).toBe(false);
  expect(requests).toHaveLength(3);
});
