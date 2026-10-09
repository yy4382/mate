import { toolTestInput } from "../../support/agent/tool-run.js";

import { randomUUID } from "node:crypto";

import { afterEach, expect, it } from "vitest";

import {
  cleanupFixture,
  createConversationFixture,
  waitForRun,
  callAgentTool,
} from "../../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

it("sends an Agent's own workspace read of a peer workspace to the node as an agent read", async () => {
  const { app, cookie, db, nodeId, socket } = await createConversationFixture();
  const agentId = randomUUID();
  const peerAgentId = randomUUID();
  app.agents.prepare({
    id: agentId,
    nodeId,
    name: "Workspace reader",
    role: "Reads a peer's workspace when the work needs it",
    description: "Synthetic peer workspace read fixture.",
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
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-peer-read-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.messages.createMessage({
    channelId: channel.id,
    text: "Read the peer's memory entry point.",
  });
  const run = await waitForRun(socket, runStart);

  const requests: Array<Record<string, unknown>> = [];
  socket.onWorkspaceOperation = async (message) => {
    requests.push(message);
    const kind = (message.operation as { kind: string }).kind;
    await toolTestInput(
      app,
      socket,
      JSON.stringify({
        type: "node.workspace.operation.result",
        requestId: message.requestId,
        operationId: message.operationId,
        agentId,
        ok: true,
        result: {
          code: 0,
          stdout:
            kind === "workspace_read_chunk"
              ? JSON.stringify({
                  base64: Buffer.from("peer memory\n").toString("base64"),
                  offset: 0,
                  totalBytes: 12,
                  version: { size: 12, device: "1", inode: "1", modifiedNs: "1", changedNs: "1" },
                })
              : JSON.stringify({ type: "file", size: 12 }),
          stderr: "",
          truncated: false,
        },
      }),
    );
  };

  // The path the Agent asked for is the path the node is asked to read, under the read mode that
  // reaches the shared workspace root. A read confined to the Agent's own directory would come
  // back as a refusal instead of the peer's file.
  const peerPath = `../${peerAgentId}/MEMORY.md`;
  const read = await callAgentTool(app, socket, run, "workspace-peer-read", "tools.call", {
    name: "workspace.read",
    input: { path: peerPath },
  });
  expect(read).toMatchObject({ ok: true, result: { content: "peer memory\n" } });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    type: "control.workspace.operation",
    agentId,
    mode: "agent_read",
    operation: { kind: "workspace_read_chunk", path: peerPath, offset: 0, length: 8192 },
  });
  // The read stays attributed to the Agent, and no file content reaches the owner activity view.
  expect(
    db
      .prepare(
        `SELECT actor_kind,actor_id,operation,result FROM owner_workspace_access_audit
         WHERE agent_id=? AND operation='read'`,
      )
      .get(agentId),
  ).toMatchObject({
    actor_kind: "agent",
    actor_id: agentId,
    operation: "read",
    result: "succeeded",
  });
  const activity = await app.http.request(`/api/owner/agents/${agentId}/activity?detail=1`, {
    headers: { cookie },
  });
  expect(await activity.text()).not.toContain("peer memory");
});
