import { mkdtempSync, rmSync } from "node:fs";
import Database from "better-sqlite3";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { OwnerAuth } from "../../src/auth/service.js";
import { nodeDirectorySchema } from "../../src/nodes/schema.js";

import { cleanupFixture } from "../support/agent/creation-fixture.js";
afterEach(cleanupFixture);

it("refuses an older experimental database without modifying its schema or node facts", () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-session-reset-"));
  const databasePath = join(directory, "control-plane.sqlite");
  const old = new Database(databasePath);
  old.exec(nodeDirectorySchema);
  old.prepare("INSERT INTO nodes(id,public_key,paired_at) VALUES('node','synthetic',10)").run();
  old.pragma("application_id = 1296257100");
  old.pragma("user_version = 4");
  old.close();
  try {
    expect(() => new OwnerAuth({ dataDir: directory })).toThrow("schema revision 4");
    const check = new Database(databasePath);
    expect(check.pragma("user_version", { simple: true })).toBe(4);
    expect(check.prepare("SELECT id FROM nodes").get()).toEqual({ id: "node" });
    check.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
