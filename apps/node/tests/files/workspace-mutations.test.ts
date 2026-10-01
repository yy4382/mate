import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createAtomicNoReplaceRename } from "../../src/files/atomic-rename.js";
import { commitFileIfHashMatches, moveFileNoReplace } from "../../src/files/workspace-mutations.js";

const roots: string[] = [];
const renameNoReplace = createAtomicNoReplaceRename(
  fileURLToPath(new URL("../../dist/files/rename-noreplace", import.meta.url)),
);
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "mate-workspace-mutations-"));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it("does not overwrite a move target created in the final pre-syscall race window", () => {
  const root = temp(),
    source = join(root, "source.txt"),
    destination = join(root, "destination.txt");
  writeFileSync(source, "original source");

  expect(() =>
    moveFileNoReplace(source, destination, renameNoReplace, () =>
      writeFileSync(destination, "concurrent target"),
    ),
  ).toThrow(/destination_exists/);
  expect(readFileSync(source, "utf8")).toBe("original source");
  expect(readFileSync(destination, "utf8")).toBe("concurrent target");
});

it("moves a source replacement instead of deleting it through a later by-path unlink", () => {
  const root = temp(),
    source = join(root, "source.txt"),
    displaced = join(root, "displaced.txt"),
    destination = join(root, "destination.txt");
  writeFileSync(source, "selected source");

  moveFileNoReplace(source, destination, renameNoReplace, () => {
    renameSync(source, displaced);
    writeFileSync(source, "concurrent replacement");
  });

  expect(readFileSync(displaced, "utf8")).toBe("selected source");
  expect(readFileSync(destination, "utf8")).toBe("concurrent replacement");
  expect(lstatSync(destination).nlink).toBe(1);
  expect(() => readFileSync(source)).toThrow();
});

it("fails a move explicitly when the atomic no-replace helper is unavailable", () => {
  const root = temp(),
    source = join(root, "source.txt"),
    destination = join(root, "destination.txt"),
    unavailableRename = createAtomicNoReplaceRename(join(root, "missing-helper"));
  writeFileSync(source, "source remains intact");

  expect(() => moveFileNoReplace(source, destination, unavailableRename)).toThrow(
    /atomic_move_unavailable/,
  );
  expect(readFileSync(source, "utf8")).toBe("source remains intact");
  expect(() => readFileSync(destination)).toThrow();
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
