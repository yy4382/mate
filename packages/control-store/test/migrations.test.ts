import { join } from "node:path";
import {
  CONTROL_STORE_FILE,
  ControlStoreIncompatible,
  openControlTables,
  type ControlTables,
} from "@mate/control-store";
import { Migrations, type Migration } from "@mate/migrations";
import { temporaryDirectory } from "@mate/testkit";
import { describe, expect, it } from "vitest";

const v1 = {
  version: 1,
  sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT",
};
const v2 = { version: 2, sql: "ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0" };
const broken = {
  version: 2,
  sql: "ALTER TABLE notes ADD COLUMN pinned INTEGER; SELECT nope FROM nowhere",
};

const notes = (...list: Migration[]): ControlTables => ({
  module: "notes",
  migrations: new Migrations(list),
});
const facts: ControlTables = {
  module: "facts",
  migrations: new Migrations([{ version: 7, sql: "CREATE TABLE facts (v TEXT) STRICT" }]),
};

function refusal(open: () => unknown): ControlStoreIncompatible {
  try {
    open();
  } catch (error) {
    if (error instanceof ControlStoreIncompatible) return error;
    throw error;
  }
  throw new Error("expected the store to be refused");
}

describe("control store migrations", () => {
  it("upgrades a module's tables on the next open, keeping its rows and leaving other modules' rows alone", () => {
    const data = temporaryDirectory();
    const old = openControlTables(data, notes(v1));
    old.prepare("INSERT INTO notes (body) VALUES ('kept')").run();
    old.close();
    const other = openControlTables(data, facts);
    other.prepare("INSERT INTO facts (v) VALUES ('untouched')").run();
    other.close();

    const upgraded = openControlTables(data, notes(v1, v2));
    expect(upgraded.prepare("SELECT body, pinned FROM notes").all()).toEqual([
      { body: "kept", pinned: 0 },
    ]);
    upgraded.close();

    const otherAgain = openControlTables(data, facts);
    expect(otherAgain.prepare("SELECT v FROM facts").all()).toEqual([{ v: "untouched" }]);
    otherAgain.close();
  });

  it("creates a new store by running the whole list, so it matches an upgraded one", () => {
    const fresh = openControlTables(temporaryDirectory(), notes(v1, v2));
    fresh.prepare("INSERT INTO notes (body, pinned) VALUES ('a', 1)").run();
    expect(fresh.prepare("SELECT body, pinned FROM notes").all()).toEqual([
      { body: "a", pinned: 1 },
    ]);
    fresh.close();
  });

  it("leaves the store at its old version when a migration fails, still openable by the old list", () => {
    const data = temporaryDirectory();
    const old = openControlTables(data, notes(v1));
    old.prepare("INSERT INTO notes (body) VALUES ('kept')").run();
    old.close();

    const error = refusal(() => openControlTables(data, notes(v1, broken)));
    expect(error.message, "the refusal names the file").toContain(join(data, CONTROL_STORE_FILE));

    const back = openControlTables(data, notes(v1));
    expect(back.prepare("SELECT body FROM notes").all()).toEqual([{ body: "kept" }]);
    expect(
      back.prepare("SELECT name FROM pragma_table_info('notes')").all(),
      "the half-applied column was rolled back",
    ).toEqual([{ name: "id" }, { name: "body" }]);
    back.close();
  });

  it("refuses a store at a version newer than the module's list, without changing it", () => {
    const data = temporaryDirectory();
    openControlTables(data, notes(v1, v2)).close();

    const error = refusal(() => openControlTables(data, notes(v1)));
    expect(error.module).toBe("notes");
    expect(error.message).toContain("schema version 2");

    openControlTables(data, notes(v1, v2)).close();
  });
});
