import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { WorkspaceOperation } from "@mate/protocol";
const roots: string[] = [];
const temp = () => {
  const root = realpathSync(mkdtempSync(`${tmpdir()}/mate-files-`));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function invoke(root: string, op: WorkspaceOperation) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../../dist/files/file-operation.mjs", import.meta.url)), root],
    { input: JSON.stringify(op), encoding: "utf8" },
  );
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
it("organizes files with hash-checked edits, non-overwriting moves and guarded removal", () => {
  const root = temp();
  expect(invoke(root, { kind: "mkdir", path: "notes" }).code).toBe(0);
  const written = invoke(root, { kind: "write", path: "notes/one.md", content: "one\ntwo\n" });
  const hash = JSON.parse(written.stdout).sha256;
  expect(
    invoke(root, {
      kind: "edit",
      path: "notes/one.md",
      expectedHash: "0".repeat(64),
      oldText: "two",
      newText: "three",
    }).code,
  ).not.toBe(0);
  expect(
    invoke(root, {
      kind: "edit",
      path: "notes/one.md",
      expectedHash: hash,
      oldText: "two",
      newText: "three",
    }).code,
  ).toBe(0);
  expect(
    JSON.parse(invoke(root, { kind: "search", path: "notes", query: "three" }).stdout).matches[0],
  ).toMatchObject({ path: `${root}/notes/one.md`, line: 2, text: "three" });
  expect(
    invoke(root, { kind: "move", path: "notes/one.md", destination: "notes/two.md" }).code,
  ).toBe(0);
  expect(
    invoke(root, { kind: "move", path: "notes/two.md", destination: "notes/two.md.history" }).code,
  ).toBe(0);
  const stat = JSON.parse(invoke(root, { kind: "stat", path: "notes/two.md.history" }).stdout);
  expect(
    invoke(root, { kind: "remove", path: "notes/two.md.history", expectedHash: stat.sha256 }).code,
  ).toBe(0);
  expect(invoke(root, { kind: "remove", path: "notes" }).code).not.toBe(0); // revision history remains
  expect(invoke(root, { kind: "remove", path: "." }).code).not.toBe(0);
});
it("rejects paths and symbolic links that escape the Agent workspace", () => {
  const root = temp();
  const outside = temp();
  writeFileSync(`${outside}/secret`, "outside");
  symlinkSync(outside, `${root}/link`);
  expect(invoke(root, { kind: "read", path: "link/secret" }).code).not.toBe(0);
  expect(invoke(root, { kind: "read", path: `${outside}/secret` }).code).not.toBe(0);
  writeFileSync(`${root}/file`, "old");
  expect(invoke(root, { kind: "move", path: "file", destination: "link/stolen" }).code).not.toBe(0);
  expect(existsSync(`${outside}/stolen`)).toBe(false);
  writeFileSync(`${root}/many`, "match\n".repeat(200));
  const result = JSON.parse(invoke(root, { kind: "search", path: "many", query: "match" }).stdout);
  expect(result.matches).toHaveLength(100);
  expect(result.truncated).toBe(true);
});
it("stdin accepts large Unicode/control-character writes without argv expansion", () => {
  const root = temp();
  const value = "你好\n\t".repeat(25000);
  expect(invoke(root, { kind: "write", path: "large", content: value }).code).toBe(0);
  expect(readFileSync(`${root}/large`, "utf8")).toBe(value);
  expect(invoke(root, { kind: "read", path: "large" }).code).not.toBe(0);
});
it("keeps direct Agent reads within the node receipt limit and directs larger reads to chunks", () => {
  const root = temp();
  const content = "x".repeat(10_000);
  expect(invoke(root, { kind: "write", path: "large.txt", content }).code).toBe(0);
  const fullRead = invoke(root, { kind: "read", path: "large.txt" });
  expect(fullRead.code).not.toBe(0);
  expect(fullRead.stderr).toContain("workspace.read_chunk");
  const chunk = JSON.parse(
    invoke(root, { kind: "workspace_read_chunk", path: "large.txt", offset: 0, length: 8192 })
      .stdout,
  );
  expect(chunk.totalBytes).toBe(10_000);
  expect(Buffer.from(chunk.base64, "base64")).toEqual(Buffer.from(content.slice(0, 8192)));
});
it("backend decodes split Unicode output as a stream", async () => {
  const root = temp();
  const helper = `${root}/synthetic.cjs`;
  writeFileSync(
    helper,
    "process.stdout.write(Buffer.from([0xe4]));setTimeout(()=>process.stdout.end(Buffer.from([0xbd,0xa0])),100);",
  );
  const { SameAccountFileBackend } = await import("../../src/files/same-account-files.js");
  const backend = new SameAccountFileBackend(
    {
      uid: process.getuid!(),
      gid: process.getgid!(),
      home: homedir(),
    },
    helper,
  );
  const result = await backend.execute({
    agentId: "test",
    root,
    operation: {
      kind: "read",
      path: ".",
    },
    timeoutMs: 2000,
  });
  expect(result.stdout).toBe("你");
});
it("binary operations accept a maximum-size canonical payload and bounded chunks without text loss", async () => {
  const root = temp();
  const { workspaceOperationSchema, WORKSPACE_WRITE_MAX_BYTES } = await import("@mate/protocol");
  const data = Buffer.alloc(WORKSPACE_WRITE_MAX_BYTES, 255);
  const op = workspaceOperationSchema.parse({
    kind: "write_bytes",
    path: "binary",
    base64: data.toString("base64"),
  });
  expect(invoke(root, op).code).toBe(0);
  const offset = data.byteLength - 1024;
  const result = JSON.parse(
    invoke(root, { kind: "read_bytes", path: "binary", offset, length: 32768 }).stdout,
  );
  expect(result.totalBytes).toBe(WORKSPACE_WRITE_MAX_BYTES);
  expect(Buffer.from(result.base64, "base64")).toEqual(data.subarray(offset));
  expect(() => workspaceOperationSchema.parse({ ...op, base64: "!!!" })).toThrow();
});
