import { Migrations } from "@mate/migrations";
import { describe, expect, it } from "vitest";

const list = new Migrations([
  { version: 1, sql: "a" },
  { version: 3, sql: "b" },
  { version: 4, sql: "c" },
]);
const versions = (found: number | undefined) => list.after(found)?.map((m) => m.version);

describe("a store's migration list", () => {
  it("reports the version of its last migration as the latest", () => {
    expect(list.latest).toBe(4);
  });

  it("gives a new store every migration and a current store none", () => {
    expect(versions(undefined)).toEqual([1, 3, 4]);
    expect(versions(4)).toEqual([]);
  });

  it("gives an older store only the migrations after its own version", () => {
    expect(versions(1)).toEqual([3, 4]);
    expect(versions(3)).toEqual([4]);
  });

  it("cannot bring a newer store, or one at a version the list does not have, to latest", () => {
    expect(versions(5)).toBeUndefined();
    expect(versions(2)).toBeUndefined();
    expect(versions(0)).toBeUndefined();
  });

  it("refuses an empty list and versions that do not strictly ascend", () => {
    expect(() => new Migrations([])).toThrow();
    expect(
      () =>
        new Migrations([
          { version: 2, sql: "a" },
          { version: 2, sql: "b" },
        ]),
    ).toThrow();
    expect(
      () =>
        new Migrations([
          { version: 3, sql: "a" },
          { version: 2, sql: "b" },
        ]),
    ).toThrow();
  });
});
