import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { workspaceOperationSchema, WORKSPACE_WRITE_MAX_BYTES } from "@mate/protocol";
import {
  agentSummarySchema,
  ownerChatEventSchema,
  ownerMessagePageSchema,
  ownerTaskSchema,
} from "@mate/protocol/owner";
import { workspaceDirectoryPageSchema, workspaceVersionSchema } from "@mate/protocol/workspace";

const version = {
  device: "0",
  inode: "123",
  size: 42,
  modifiedNs: "12345678901234567890",
  changedNs: "12345678901234567891",
};

test("workspace versions retain the shared strict decimal and safe-integer contract", () => {
  assert.deepEqual(workspaceVersionSchema.parse(version), version);
  assert.equal(
    workspaceVersionSchema.safeParse({ ...version, size: Number.MAX_SAFE_INTEGER }).success,
    true,
  );
  for (const invalid of [
    { ...version, device: "" },
    { ...version, inode: "-1" },
    { ...version, modifiedNs: "1.5" },
    { ...version, changedNs: "１２３" },
    { ...version, size: -1 },
    { ...version, size: 0.5 },
    { ...version, size: Number.MAX_SAFE_INTEGER + 1 },
    { ...version, extra: true },
  ]) {
    assert.equal(workspaceVersionSchema.safeParse(invalid).success, false);
    assert.equal(
      workspaceOperationSchema.safeParse({
        kind: "workspace_read_chunk",
        path: "file.txt",
        offset: 0,
        length: 8192,
        version: invalid,
      }).success,
      false,
    );
  }
  const request = {
    kind: "workspace_read_chunk",
    path: "file.txt",
    offset: 0,
    length: 8192,
    version,
  };
  assert.deepEqual(workspaceOperationSchema.parse(request), request);
  const { version: omitted, ...withoutVersion } = request;
  assert.deepEqual(workspaceOperationSchema.parse(withoutVersion), withoutVersion);
});

test("workspace operation defaults, unknown fields, and byte refinements stay unchanged", () => {
  assert.deepEqual(workspaceOperationSchema.parse({ kind: "workspace_list", path: "" }), {
    kind: "workspace_list",
    path: "",
    offset: 0,
    limit: 32,
  });
  assert.equal(
    workspaceOperationSchema.safeParse({ kind: "workspace_list", path: "", extra: true }).success,
    false,
  );
  assert.equal(
    workspaceOperationSchema.safeParse({ kind: "write_bytes", path: "file.txt", base64: "aA==" })
      .success,
    true,
  );
  assert.equal(
    workspaceOperationSchema.safeParse({ kind: "write_bytes", path: "file.txt", base64: "aA" })
      .success,
    false,
  );
  assert.equal(
    workspaceOperationSchema.safeParse({
      kind: "write",
      path: "file.txt",
      content: "a".repeat(WORKSPACE_WRITE_MAX_BYTES),
    }).success,
    true,
  );
  assert.equal(
    workspaceOperationSchema.safeParse({
      kind: "write",
      path: "file.txt",
      content: "中".repeat(Math.floor(WORKSPACE_WRITE_MAX_BYTES / 3) + 1),
    }).success,
    false,
  );
});

test("owner message projections preserve recursive replies, authors, and cursor strings", () => {
  const reply = {
    id: "reply",
    channelId: "channel",
    rootId: "root",
    quoteId: null,
    replyCount: 0,
    recentReplies: [],
    author: { kind: "agent", id: "agent" },
    text: "reply",
    order: "9007199254740992",
    createdAt: 2,
  };
  const page = {
    messages: [
      {
        ...reply,
        id: "root",
        rootId: null,
        replyCount: 1,
        recentReplies: [reply],
        author: { kind: "human", id: "owner" },
        order: "9007199254740991",
        createdAt: 1,
      },
    ],
    nextBefore: "9007199254740991",
  };
  assert.deepEqual(ownerMessagePageSchema.parse(page), page);
  assert.equal(
    ownerMessagePageSchema.safeParse({
      ...page,
      messages: [{ ...reply, author: { kind: "human", id: "someone_else" } }],
    }).success,
    false,
  );
  assert.equal(
    ownerMessagePageSchema.safeParse({ ...page, nextBefore: 9007199254740991 }).success,
    false,
  );
});

test("owner task and workspace pages describe the existing complete wire projections", () => {
  const task = {
    id: "task",
    messageId: "message",
    channelId: "channel",
    title: "Prepare summary",
    status: "open",
    ownerAgentId: null,
    ownerAgentName: null,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  assert.deepEqual(ownerTaskSchema.parse(task), task);
  const directory = { path: "", entries: [], nextOffset: 32 };
  assert.deepEqual(workspaceDirectoryPageSchema.parse(directory), directory);
  assert.equal(
    workspaceDirectoryPageSchema.safeParse({ ...directory, nextOffset: "32" }).success,
    false,
  );
});

test("owner summaries retain opaque event and stop payloads without provider dependencies", () => {
  const receipt = { vendorField: { nested: [1, "two", null] }, reason: "pending_process_receipts" };
  const agent = {
    id: "agent",
    nodeId: "node",
    name: "Colleague",
    role: "Research",
    description: "",
    model: { provider: "any-provider", id: "any-model" },
    initialChannelId: null,
    sessionId: "session",
    status: "ready",
    stage: "complete",
    error: null,
    linuxIdentity: { username: "mate", uid: 1000, gid: 1000, workspace: "/tmp/agent" },
    createdAt: 1,
    updatedAt: 2,
    pausedReason: "manual",
    stop: { state: "unknown", receipt, scope: "this_node_run", unconfirmedOperationIds: ["op"] },
  };
  assert.deepEqual(agentSummarySchema.parse(agent), agent);
  const { pausedReason, stop, ...unpaused } = agent;
  assert.deepEqual(agentSummarySchema.parse(unpaused), unpaused);
  const event = { seq: 1, kind: "custom", channelId: "channel", payload: receipt, createdAt: 1 };
  assert.deepEqual(ownerChatEventSchema.parse(event), event);
});

test("owner and workspace entry points import and parse without Node globals or Pi", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { registerHooks } from "node:module";
        registerHooks({
          resolve(specifier, context, nextResolve) {
            if (specifier.startsWith("node:") || specifier.startsWith("@earendil-works/") ||
                specifier.endsWith("/messages.js") || specifier.endsWith("/workspace-operations.js")) {
              throw new Error("Server dependency reached from browser entry point: " + specifier);
            }
            return nextResolve(specifier, context);
          },
        });
        globalThis.Buffer = undefined;
        const owner = await import("@mate/protocol/owner");
        const workspace = await import("@mate/protocol/workspace");
        owner.ownerChatSnapshotSchema.parse({ channels: [], cursor: 0 });
        owner.agentStopSchema.parse({ state: "unknown", receipt: null });
        workspace.workspaceVersionSchema.parse(${JSON.stringify(version)});
      `,
    ],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
