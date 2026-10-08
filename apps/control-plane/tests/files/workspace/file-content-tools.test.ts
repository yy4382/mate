import { afterEach, expect, it } from "vitest";
import {
  cleanupAgentToolFixture,
  setup,
  authorizeModel,
  addAgent,
  waitForRuns,
} from "../../support/agent/agent-tool-fixture.js";

async function fileTools(bytes: Buffer, fault?: "short" | "changed" | "revoked") {
  const fixture = await setup();
  const { app, cookie, nodeId, socket } = fixture;
  const agentId = addAgent(app, nodeId, "File reader");
  const direct = app.chat.conversations.getOrCreateAgentDirectChannel(agentId)!;
  await authorizeModel(app, cookie);
  app.chat.messages.createMessage({ channelId: direct.id, text: "Read bytes." });
  const run = (await waitForRuns(socket, 0, [agentId])).get(agentId)!;
  const version = { size: bytes.length, modifiedNs: "1", changedNs: "1", inode: "1", device: "1" };
  let reads = 0;
  socket.onSend = (message) => {
    if (message.type !== "control.workspace.operation") return;
    const op = message.operation;
    reads++;
    if (fault === "revoked" && reads === 2)
      fixture.db
        .prepare("UPDATE owner_agent_runs SET state='interrupted' WHERE id=?")
        .run(run.runId);
    const stdout =
      op.kind === "workspace_read_chunk"
        ? JSON.stringify({
            base64: bytes
              .subarray(op.offset, op.offset + (fault === "short" && reads === 2 ? 0 : op.length))
              .toString("base64"),
            offset: op.offset,
            totalBytes: bytes.length,
            version: fault === "changed" && reads === 2 ? { ...version, modifiedNs: "2" } : version,
          })
        : bytes.toString("utf8");
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
  return {
    ...fixture,
    direct,
    agentId,
    run,
    call: (name: string, input: Record<string, unknown>) =>
      app.tools.execute({ runId: run.runId, agentId, nodeId, toolCallId: "read" }, "tools.call", {
        name,
        input,
      }),
  };
}

it("keeps Chinese range boundaries readable and reports the actual byte range and continuation", async () => {
  const { call } = await fileTools(Buffer.from("A中文B"));
  expect(await call("workspace.read_chunk", { path: "text", offset: 2, length: 3 })).toMatchObject({
    ok: true,
    result: {
      content: "中文",
      offset: 1,
      nextOffset: 7,
      requestedOffset: 2,
      requestedLength: 3,
      totalBytes: 8,
    },
  });
});

it.each([
  ["jpeg", "ffd8ffe000104a4649460001", "image/jpeg"],
  ["gif", "47494638396101000100", "image/gif"],
  ["webp", "524946461000000057454250", "image/webp"],
  ["pdf", "255044462d312e370a", "application/pdf"],
])(
  "classifies %s from bytes even when a requested range omits its signature",
  async (_name, hex, type) => {
    const { call } = await fileTools(
      Buffer.concat([Buffer.from(hex, "hex"), Buffer.from("plain-looking-tail")]),
    );
    const result = await call("workspace.read_chunk", {
      path: "misleading.txt",
      offset: 12,
      length: 4,
    });
    expect(result).toMatchObject({
      ok: true,
      result: { type, unreadable: expect.stringContaining("process.exec") },
    });
    expect(JSON.stringify(result)).not.toMatch(/base64|plain-looking-tail/);
  },
);

it("accepts an 8 KiB probe ending inside a Chinese character and checks the later requested range", async () => {
  const { call } = await fileTools(Buffer.from("a".repeat(8191) + "中文后续"));
  expect(
    await call("workspace.read_chunk", { path: "text", offset: 8192, length: 3 }),
  ).toMatchObject({ ok: true, result: { content: "中文", offset: 8191, nextOffset: 8197 } });
});

it("does not leak an invalid UTF-8 range past a textual prefix, and reads empty text", async () => {
  const binary = await fileTools(
    Buffer.concat([Buffer.alloc(8192, 65), Buffer.from([0xff, 0, 1])]),
  );
  expect(
    await binary.call("workspace.read_chunk", { path: "binary", offset: 8192, length: 3 }),
  ).toMatchObject({
    ok: true,
    result: { type: "application/octet-stream", unreadable: expect.any(String) },
  });
  const empty = await fileTools(Buffer.alloc(0));
  expect(await empty.call("workspace.read", { path: "empty" })).toEqual({
    ok: true,
    result: { content: "" },
  });
  expect(await empty.call("workspace.read_chunk", { path: "empty", offset: 0 })).toMatchObject({
    ok: true,
    result: { content: "", offset: 0, nextOffset: 0 },
  });
});

it("keeps uploaded images out of vision even with text MIME, while reading uploaded Chinese text", async () => {
  const { app, direct, call } = await fileTools(Buffer.alloc(0));
  const upload = (bytes: Buffer, contentType: string) =>
    app.attachments.uploadForOwner({
      channelId: direct.id,
      filename: "claim.txt",
      contentType,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    });
  const image = await upload(Buffer.from("47494638396101000100", "hex"), "text/plain");
  const refused = await call("attachments.read_chunk", {
    conversationId: direct.id,
    attachmentId: image.id,
    offset: 6,
  });
  expect(refused).toMatchObject({
    ok: true,
    result: { type: "image/gif", unreadable: expect.any(String) },
  });
  expect(JSON.stringify(refused)).not.toContain("base64");
  const text = await upload(Buffer.from("A中文B"), "image/png");
  expect(
    await call("attachments.read_chunk", {
      conversationId: direct.id,
      attachmentId: text.id,
      offset: 2,
      length: 3,
    }),
  ).toMatchObject({ ok: true, result: { content: "中文", offset: 1, nextOffset: 7 } });
});

it.each(["short", "changed", "revoked"] as const)(
  "refuses a complete image when the second chunk is %s",
  async (fault) => {
    const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(9000)]);
    const { call } = await fileTools(bytes, fault);
    const result = await call("workspace.read", { path: "picture" });
    expect(result).toMatchObject({ ok: false, error: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(bytes.toString("base64"));
  },
);

it("refuses an oversized image after bounded probing without returning its bytes", async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 1);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  const { call, socket } = await fileTools(bytes);
  const result = await call("workspace.read", { path: "huge" });
  expect(result).toMatchObject({
    ok: true,
    result: { type: "image/png", unreadable: expect.stringContaining("5 MiB") },
  });
  expect(
    socket.sent
      .map((text) => JSON.parse(text))
      .filter((item) => item.type === "control.workspace.operation"),
  ).toHaveLength(1);
});

it("keeps text navigation lossless at four-byte characters and refuses private uploaded bytes", async () => {
  const { call, app } = await fileTools(Buffer.from("A😀B"));
  expect(await call("workspace.read_chunk", { path: "text", offset: 1, length: 1 })).toMatchObject({
    ok: true,
    result: { content: "😀", offset: 1, nextOffset: 5 },
  });
  expect(await call("workspace.read_chunk", { path: "text", offset: 5, length: 1 })).toMatchObject({
    ok: true,
    result: { content: "B", offset: 5, nextOffset: 6 },
  });
  const privateChannel = app.chat.channels.createChannel({
    name: "Private images",
    visibility: "private",
    description: "",
  });
  const attachment = await app.attachments.uploadForOwner({
    channelId: privateChannel.id,
    filename: "secret",
    contentType: "text/plain",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from("47494638396101000100", "hex"));
        controller.close();
      },
    }),
  });
  expect(
    await call("attachments.read_chunk", {
      conversationId: privateChannel.id,
      attachmentId: attachment.id,
      offset: 0,
    }),
  ).toMatchObject({ ok: false, error: expect.any(String) });
});

afterEach(cleanupAgentToolFixture);
