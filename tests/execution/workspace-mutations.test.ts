import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  commitFileIfHashMatches,
  moveFileNoReplace,
} from "../../src/execution/workspace-mutations.js";

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "mate-workspace-mutations-"));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it("does not overwrite a move target created after the request began", () => {
  const root = temp(),
    source = join(root, "source.txt"),
    destination = join(root, "destination.txt");
  writeFileSync(source, "original source");

  expect(() =>
    moveFileNoReplace(source, destination, () => writeFileSync(destination, "concurrent target")),
  ).toThrow(/destination_exists/);
  expect(readFileSync(source, "utf8")).toBe("original source");
  expect(readFileSync(destination, "utf8")).toBe("concurrent target");
});

it("rejects an edit if the file changes between its initial hash check and commit", () => {
  const root = temp(),
    path = join(root, "shared.txt"),
    original = Buffer.from("before"),
    concurrent = Buffer.from("written by another command"),
    replacement = Buffer.from("edited");
  writeFileSync(path, original);
  const expectedHash = createHash("sha256").update(original).digest("hex"),
    commit = vi.fn(() => writeFileSync(path, replacement));

  expect(() =>
    commitFileIfHashMatches(
      expectedHash,
      () => readFileSync(path),
      commit,
      () => writeFileSync(path, concurrent),
    ),
  ).toThrow(/file_changed/);
  expect(commit).not.toHaveBeenCalled();
  expect(readFileSync(path)).toEqual(concurrent);
});
