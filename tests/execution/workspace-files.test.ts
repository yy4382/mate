import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { operationSchema } from "../../src/execution/backend.js";

const roots: string[] = [];
const temp = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mate-workspace-files-")));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function invoke(root: string, operation: Record<string, unknown>) {
  const result = spawnSync(
    process.execPath,
    [resolve("dist/src/execution/file-operation.mjs"), root],
    { input: JSON.stringify(operation), encoding: "utf8" },
  );
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

it("lists the private home without following symbolic links and reads a file in bounded chunks", () => {
  const root = temp(),
    outside = temp();
  writeFileSync(join(root, "notes.txt"), "first page\nsecond page\n");
  writeFileSync(join(outside, "secret.txt"), "outside");
  symlinkSync(outside, join(root, "outside-link"));

  const listing = invoke(root, { kind: "workspace_list", path: ".", offset: 0, limit: 32 });
  expect(listing.code).toBe(0);
  expect(JSON.parse(listing.stdout)).toMatchObject({
    path: ".",
    entries: [
      { name: "notes.txt", type: "file", size: 23 },
      { name: "outside-link", type: "symlink" },
    ],
    nextOffset: null,
  });

  const stat = invoke(root, { kind: "workspace_stat", path: "notes.txt" });
  expect(stat.code).toBe(0);
  const version = JSON.parse(stat.stdout).version;
  const first = invoke(root, {
    kind: "workspace_read_chunk",
    path: "notes.txt",
    offset: 0,
    length: 6,
    version,
  });
  expect(first.code).toBe(0);
  expect(Buffer.from(JSON.parse(first.stdout).base64, "base64").toString()).toBe("first ");
  expect(JSON.parse(first.stdout).version).toEqual(version);
});

it("rejects traversal and symbolic-link reads outside the selected home", () => {
  const root = temp(),
    outside = temp();
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(root, "secret-link"));

  expect(invoke(root, { kind: "workspace_read_chunk", path: "../secret.txt", offset: 0, length: 6 }).code).not.toBe(0);
  expect(invoke(root, { kind: "workspace_read_chunk", path: "secret-link", offset: 0, length: 6 }).code).not.toBe(0);
});

it("refuses to continue a streamed read after the file changes", () => {
  const root = temp(),
    path = join(root, "changing.txt");
  writeFileSync(path, "before");
  const stat = invoke(root, { kind: "workspace_stat", path: "changing.txt" });
  expect(stat.code).toBe(0);
  const version = JSON.parse(stat.stdout).version;
  writeFileSync(path, "after!");

  const changed = invoke(root, {
    kind: "workspace_read_chunk",
    path: "changing.txt",
    offset: 0,
    length: 6,
    version,
  });
  expect(changed.code).not.toBe(0);
  expect(changed.stderr).toContain("file_changed");
});

it("validates bounded workspace requests before they reach a node", () => {
  expect(
    operationSchema.parse({ kind: "workspace_list", path: "notes" }),
  ).toEqual({ kind: "workspace_list", path: "notes", offset: 0, limit: 32 });
  expect(() =>
    operationSchema.parse({
      kind: "workspace_read_chunk",
      path: "notes/file.txt",
      offset: 0,
      length: 32769,
    }),
  ).toThrow();
});
