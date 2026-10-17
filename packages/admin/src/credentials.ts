import type { DatabaseSync } from "node:sqlite";
import { openControlTables, type ControlTables } from "@mate/control-store";
import type { ProviderCredentials } from "@mate/runtime";
import { z } from "zod";

const ADMIN_TABLES: ControlTables = {
  module: "admin",
  version: 1,
  ddl: `
CREATE TABLE provider_credentials (
  provider TEXT PRIMARY KEY,
  api_key TEXT NOT NULL,
  base_url TEXT
) STRICT;
`,
};

const Row = z
  .object({ api_key: z.string(), base_url: z.string().nullable() })
  .optional()
  .transform((row): ProviderCredentials | undefined =>
    row === undefined
      ? undefined
      : { apiKey: row.api_key, ...(row.base_url === null ? {} : { baseUrl: row.base_url }) },
  );

/**
 * Each provider's credentials, in the admin module's own tables of the control store. Runtimes read them at every
 * model request, so the stored row is the only copy and a change applies from the next request.
 */
export class CredentialStore {
  readonly #db: DatabaseSync;

  constructor(dataDirectory: string) {
    this.#db = openControlTables(dataDirectory, ADMIN_TABLES);
  }

  get(provider: string): ProviderCredentials | undefined {
    return Row.parse(
      this.#db
        .prepare("SELECT api_key, base_url FROM provider_credentials WHERE provider = ?")
        .get(provider),
    );
  }

  set(provider: string, credentials: ProviderCredentials): void {
    this.#db
      .prepare(
        `INSERT INTO provider_credentials (provider, api_key, base_url) VALUES (?, ?, ?)
         ON CONFLICT (provider) DO UPDATE SET api_key = excluded.api_key, base_url = excluded.base_url`,
      )
      .run(provider, credentials.apiKey, credentials.baseUrl ?? null);
  }

  delete(provider: string): void {
    this.#db.prepare("DELETE FROM provider_credentials WHERE provider = ?").run(provider);
  }

  close(): void {
    this.#db.close();
  }
}
