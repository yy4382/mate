import { afterEach, expect, it } from "vitest";

import {
  cleanupFixture,
  setup,
  prepareVerifiedAgent,
  waitForRun,
  callAgentTool,
} from "../../support/agent/conversation-fixture.js";
afterEach(cleanupFixture);

it("lets a non-member Agent read a public channel's attachments but keeps publish member-only", async () => {
  const { app, cookie, nodeId, socket } = await setup();
  const agentId = await prepareVerifiedAgent(app, nodeId, "Attachment reader");
  const ownDirect = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  const publicRoom = app.chat.channels.createChannel({
    name: "Open files",
    description: "Public attachments are readable.",
    visibility: "public",
  });
  const privateRoom = app.chat.channels.createChannel({
    name: "Closed files",
    description: "Private attachments stay closed.",
    visibility: "private",
  });
  const upload = async (channelId: string, filename: string, body: string) =>
    app.http.request(`/api/owner/channels/${channelId}/attachments`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "text/plain; charset=utf-8",
        "x-mate-filename": encodeURIComponent(filename),
      },
      body: new TextEncoder().encode(body),
    });
  const publicUpload = await upload(publicRoom.id, "公开.txt", "public attachment body");
  expect(publicUpload.status).toBe(201);
  const publicAttachment = (await publicUpload.json()) as { attachment: { id: string } };
  expect((await upload(privateRoom.id, "机密.txt", "private attachment body")).status).toBe(201);
  await app.http.request("/api/owner/model-credentials/openai", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "synthetic-tools-key" }),
  });
  const runStart = socket.sent.length;
  app.chat.messages.createMessage({
    channelId: ownDirect.id,
    text: "Start a conversation tool run.",
  });
  const run = await waitForRun(socket, runStart);

  const publicList = await callAgentTool(app, socket, run, "list-public-files", "tools.call", {
    name: "attachments.list",
    input: { conversationId: publicRoom.id },
  });
  expect(publicList).toMatchObject({ ok: true });
  expect((publicList.result as { attachments: Array<{ id: string }> }).attachments).toEqual([
    expect.objectContaining({ id: publicAttachment.attachment.id }),
  ]);
  const publicChunk = await callAgentTool(app, socket, run, "read-public-file", "tools.call", {
    name: "attachments.read_chunk",
    input: {
      conversationId: publicRoom.id,
      attachmentId: publicAttachment.attachment.id,
      offset: 0,
    },
  });
  expect(publicChunk).toMatchObject({ ok: true });
  expect(publicChunk.result).toMatchObject({ content: "public attachment body" });

  const privateList = await callAgentTool(app, socket, run, "list-private-files", "tools.call", {
    name: "attachments.list",
    input: { conversationId: privateRoom.id },
  });
  expect(privateList.ok).toBe(false);
  const publish = await callAgentTool(app, socket, run, "publish-public-file", "tools.call", {
    name: "attachments.publish",
    input: { conversationId: publicRoom.id, path: "notes.txt" },
  });
  expect(publish.ok).toBe(false);
});
