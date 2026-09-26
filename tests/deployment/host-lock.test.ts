import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { nodeHostOperations } from "../../src/deployment/host.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it("holds a kernel lock through the shared deployment host until released", () => {
  const root = mkdtempSync(join(tmpdir(), "mate-host-lock-"));
  roots.push(root);
  const host = nodeHostOperations(),
    path = join(root, "control-plane.lock");
  const release = host.lockExclusive(path);
  try {
    expect(() => host.lockExclusive(path)).toThrow(
      "Another Mate process holds the state directory lock",
    );
  } finally {
    release();
  }
  const secondRelease = host.lockExclusive(path);
  secondRelease();
});
