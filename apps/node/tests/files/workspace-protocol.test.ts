import { expect, it } from "vitest";
import {
  WORKSPACE_WRITE_BYTES_BASE64_MAX_CHARS,
  WORKSPACE_WRITE_MAX_BYTES,
  operationSchema,
  MAX_NODE_MESSAGE_BYTES,
  NodeControlMessageSchema,
  NodeRequestSchema,
} from "@mate/protocol";

import { sendWorkspaceOperationResult } from "../../src/files/workspace-result.js";

const requestId = "2ee1d608-4dc4-458a-b143-3c6a7919e84a";
const agentId = "7cd3ed23-c885-4f27-8278-a5467a69fb96";

it("keeps the largest documented binary workspace write inside the complete WebSocket frame", () => {
  const bytes = Buffer.alloc(WORKSPACE_WRITE_MAX_BYTES, 0x61);
  const base64 = bytes.toString("base64");
  const path = "🧪".repeat(1365);
  const workspaceRequest = {
    type: "control.workspace.operation",
    requestId,
    operationId: "5fe049b7-0cd2-4f37-aea1-4636e151f3bf",
    agentId,
    mode: "agent_action",
    operation: { kind: "write_bytes", path, base64 },
  };

  expect(base64).toHaveLength(WORKSPACE_WRITE_BYTES_BASE64_MAX_CHARS);
  expect(operationSchema.parse(workspaceRequest.operation)).toEqual(workspaceRequest.operation);
  expect(NodeControlMessageSchema.parse(workspaceRequest)).toEqual(workspaceRequest);
  expect(Buffer.byteLength(JSON.stringify(workspaceRequest))).toBeLessThan(MAX_NODE_MESSAGE_BYTES);
});

it("rejects text whose UTF-8 size fits but JSON escaping would exceed a node frame", () => {
  const content = "\u0001".repeat(Math.floor(WORKSPACE_WRITE_MAX_BYTES / 2));
  const workspaceRequest = {
    type: "control.workspace.operation",
    requestId,
    operationId: "5fe049b7-0cd2-4f37-aea1-4636e151f3bf",
    agentId,
    mode: "agent_action",
    operation: { kind: "write", path: "notes.txt", content },
  };
  expect(Buffer.byteLength(content)).toBeLessThan(WORKSPACE_WRITE_MAX_BYTES);
  expect(Buffer.byteLength(JSON.stringify(workspaceRequest))).toBeGreaterThan(
    MAX_NODE_MESSAGE_BYTES,
  );
  expect(NodeControlMessageSchema.safeParse(workspaceRequest).success).toBe(false);
});

it("rejects a decoded binary write one byte above the advertised limit", () => {
  const overLimit = Buffer.alloc(WORKSPACE_WRITE_MAX_BYTES + 1).toString("base64");
  expect(() =>
    operationSchema.parse({ kind: "write_bytes", path: "file.bin", base64: overLimit }),
  ).toThrow();
});

it("accepts a typical long file-system error as a bounded workspace result", () => {
  const message = {
    type: "node.workspace.operation.result",
    requestId,
    operationId: "5fe049b7-0cd2-4f37-aea1-4636e151f3bf",
    agentId,
    ok: true,
    result: {
      code: 1,
      stdout: "",
      stderr: `Error: ENOENT: no such file or directory, open '${"a".repeat(650)}'\n    at openSync (node:fs:...)`,
      truncated: false,
    },
  };
  expect(NodeRequestSchema.parse(message)).toEqual(message);
});

it("bounds oversized helper output but preserves structured error text", () => {
  let sent: unknown;
  sendWorkspaceOperationResult(
    (message) => {
      sent = message;
    },
    { requestId, operationId: "5fe049b7-0cd2-4f37-aea1-4636e151f3bf", agentId },
    {
      code: 1,
      stdout: "",
      stderr: `workspace_stat: ENOENT '${"x".repeat(13_000)}`,
      truncated: false,
    },
  );
  expect(NodeRequestSchema.parse(sent)).toMatchObject({
    ok: true,
    result: { stderr: expect.stringMatching(/^workspace_stat: ENOENT/), truncated: true },
  });
  expect((sent as { result: { stderr: string } }).result.stderr).toHaveLength(12_000);
});

it("swallows both primary and fallback send failures without an unhandled rejection", () => {
  let sends = 0;
  expect(() =>
    sendWorkspaceOperationResult(
      () => {
        sends++;
        throw new Error("socket is closed");
      },
      { requestId, operationId: "5fe049b7-0cd2-4f37-aea1-4636e151f3bf", agentId },
      { code: 0, stdout: "", stderr: "", truncated: false },
    ),
  ).not.toThrow();
  expect(sends).toBe(2);
});

it("preserves a stable file failure code when wire output is truncated", () => {
  let sent: unknown;
  sendWorkspaceOperationResult(
    (message) => {
      sent = message;
    },
    { requestId, operationId: "5fe049b7-0cd2-4f37-aea1-4636e151f3bf", agentId },
    {
      code: 1,
      errorCode: "permission_denied",
      stdout: "",
      stderr: "operation_unknown: ".repeat(1_000),
      truncated: false,
    },
  );
  expect(NodeRequestSchema.parse(sent)).toMatchObject({
    ok: true,
    result: { code: 1, errorCode: "permission_denied", truncated: true },
  });
});
