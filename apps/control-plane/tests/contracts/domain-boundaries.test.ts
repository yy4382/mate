import { expect, it } from "vitest";
import { workspaceVersionSchema } from "@mate/protocol/workspace";
import {
  isWorkspaceVersion,
  parseEnvelope,
  parseOperationReceipt,
  workspaceDirectoryResultSchema,
  workspaceStatResultSchema,
} from "../../src/workspaces/results.js";
import { parseActionResult, parsePublishedAttachment } from "../../src/attachments/results.js";

it("keeps loose node version results distinct from strict request versions", () => {
  const version = {
    device: "device-name",
    inode: "inode-name",
    size: -1,
    modifiedNs: "timestamp",
    changedNs: "timestamp",
    extension: { retained: true },
  };
  expect(isWorkspaceVersion(version)).toBe(true);
  expect(workspaceVersionSchema.safeParse(version).success).toBe(false);
  expect(isWorkspaceVersion({ ...version, size: 1.5 })).toBe(false);
  expect(isWorkspaceVersion({ ...version, size: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
  const stat = { type: "file", size: 0, modifiedAt: 0, version, extension: true };
  expect(workspaceStatResultSchema.parse(stat)).toEqual(stat);
});

it("preserves directory extensions and the legacy absence of a path check", () => {
  const listing = {
    entries: [{ name: "file", type: "file", size: 0, extension: true }],
    nextOffset: -1,
    extension: true,
  };
  expect(workspaceDirectoryResultSchema.parse(listing)).toEqual(listing);
  expect(
    workspaceDirectoryResultSchema.safeParse({
      ...listing,
      entries: [{ name: "file", type: "file", size: -1 }],
    }).success,
  ).toBe(false);
  expect(workspaceDirectoryResultSchema.safeParse({ ...listing, nextOffset: 1.5 }).success).toBe(
    false,
  );
});

it("keeps uncertain workspace receipts readable without accepting malformed state", () => {
  expect(
    parseEnvelope(
      JSON.stringify({
        state: "future_state",
        operationId: 7,
        runId: "run",
        revision: -1,
        result: { extension: true },
      }),
    ),
  ).toEqual({ state: "future_state", runId: "run", result: { extension: true } });
  expect(parseEnvelope(JSON.stringify({ state: "succeeded", revision: 2, result: null }))).toEqual({
    state: "succeeded",
    revision: 2,
    result: null,
  });
  expect(() => parseEnvelope('{"state":1}')).toThrow("文件操作收据无法读取。");
  expect(parseOperationReceipt("[1,null]")).toEqual([1, null]);
  expect(() => parseOperationReceipt("invalid")).toThrow("节点操作收据无法读取。");
});

it("retains the existing tolerant attachment receipt projection", () => {
  expect(parseActionResult('{"state":"future_state","operationId":3,"result":null}')).toEqual({
    state: "future_state",
    result: null,
  });
  const receipt = {
    id: "attachment",
    channelId: "channel",
    filename: "file",
    size: -1,
    sha256: "digest",
    uploader: "legacy",
    extension: true,
  };
  expect(parsePublishedAttachment(receipt)).toEqual(receipt);
  expect(parsePublishedAttachment(JSON.stringify(receipt))).toEqual(receipt);
  expect(() => parsePublishedAttachment({ ...receipt, uploader: null })).toThrow(
    "发布收据无法读取。",
  );
  expect(() => parseActionResult('{"state":1}')).toThrow("文件发布收据无法读取。");
});
