/** One step of a store's schema: the SQL that brings a store from the previous listed version to `version`. */
export type Migration = { readonly version: number; readonly sql: string };

/**
 * A store's schema, as an ascending list of migrations. A new store runs the whole list and an existing store runs
 * only the entries after its own version, so a fresh store and a migrated one cannot differ: there is no separate
 * "current" DDL to keep in step.
 */
export class Migrations {
  readonly #list: readonly Migration[];
  /** The version a store is at after the last migration. */
  readonly latest: number;

  constructor(list: readonly Migration[]) {
    const last = list.at(-1);
    if (last === undefined) throw new Error("a store needs at least one migration");
    for (const [index, migration] of list.entries()) {
      const previous = list[index - 1];
      if (previous !== undefined && migration.version <= previous.version) {
        throw new Error(
          `migration versions must strictly ascend: ${migration.version} follows ${previous.version}`,
        );
      }
    }
    this.#list = list;
    this.latest = last.version;
  }

  /**
   * The migrations that bring a store at `found` to `latest`: all of them when `found` is undefined (a new store),
   * none when it is already there. Undefined when the store cannot be brought there: it is newer than the code, or at
   * a version this list does not have.
   */
  after(found: number | undefined): readonly Migration[] | undefined {
    if (found === undefined) return this.#list;
    const index = this.#list.findIndex((migration) => migration.version === found);
    return index === -1 ? undefined : this.#list.slice(index + 1);
  }
}
