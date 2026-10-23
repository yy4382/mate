import { statSync } from "node:fs";
import { join } from "node:path";
import { openControlTables, CONTROL_STORE_FILE } from "@mate/control-store";
import { Migrations } from "@mate/migrations";
import { temporaryDirectory } from "@mate/testkit";
import { describe, expect, it } from "vitest";

const tables = {
  module: "test",
  migrations: new Migrations([{ version: 1, sql: "CREATE TABLE secrets (value TEXT) STRICT" }]),
};

const mode = (file: string) => statSync(file).mode & 0o777;

describe("control store file permissions", () => {
  it("creates control.sqlite and its WAL readable and writable by its owner only", () => {
    const data = temporaryDirectory();
    const previous = process.umask(0o022);
    try {
      const db = openControlTables(data, tables);
      db.prepare("INSERT INTO secrets (value) VALUES ('hash')").run();
      const file = join(data, CONTROL_STORE_FILE);
      expect(mode(file), "the store").toBe(0o600);
      expect(mode(`${file}-wal`), "its write-ahead log").toBe(0o600);
      db.close();
    } finally {
      process.umask(previous);
    }
  });
});
