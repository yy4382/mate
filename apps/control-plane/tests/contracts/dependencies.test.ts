import { expect, it } from "vitest";
import Database from "better-sqlite3";
it("SQLite rolls back atomically with foreign keys enabled", () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    db.exec(
      "CREATE TABLE parent(id TEXT PRIMARY KEY); CREATE TABLE child(id TEXT REFERENCES parent(id));",
    );
    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO parent VALUES (?)").run("one");
        db.prepare("INSERT INTO child VALUES (?)").run("missing");
      })(),
    ).toThrow();
    expect(db.prepare("SELECT * FROM parent").all()).toEqual([]);
  } finally {
    db.close();
  }
});
