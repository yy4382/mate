import type Database from "better-sqlite3";
import { isSupportedModelProvider } from "./model-providers.js";

export interface ModelCredentialSummary {
  provider: string;
  configured: true;
  updatedAt: number;
}

/** API keys are control-plane secrets. Callers can list presence or read a key for one run. */
export class ModelCredentialDirectory {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  list(): ModelCredentialSummary[] {
    const rows = this.db
      .prepare("SELECT provider,updated_at FROM model_credentials ORDER BY provider")
      .all() as Array<{ provider: string; updated_at: number }>;
    return rows.map((row) => ({
      provider: row.provider,
      configured: true,
      updatedAt: row.updated_at,
    }));
  }

  has(provider: string): boolean {
    if (!isSupportedModelProvider(provider)) return false;
    return (
      this.db.prepare("SELECT 1 FROM model_credentials WHERE provider=?").get(provider) !==
      undefined
    );
  }

  readForRun(provider: string): string | undefined {
    if (!isSupportedModelProvider(provider)) return undefined;
    const row = this.db
      .prepare("SELECT api_key FROM model_credentials WHERE provider=?")
      .get(provider) as { api_key: string } | undefined;
    return row?.api_key;
  }

  put(provider: string, apiKey: string): boolean {
    if (!isSupportedModelProvider(provider)) return false;
    const existing = this.db
      .prepare("SELECT api_key FROM model_credentials WHERE provider=?")
      .get(provider) as { api_key: string } | undefined;
    if (existing?.api_key === apiKey) return false;
    this.db
      .prepare(
        `INSERT INTO model_credentials(provider,api_key,updated_at) VALUES(?,?,?)
         ON CONFLICT(provider) DO UPDATE SET api_key=excluded.api_key,updated_at=excluded.updated_at`,
      )
      .run(provider, apiKey, this.now());
    return true;
  }

  delete(provider: string): boolean {
    if (!isSupportedModelProvider(provider)) return false;
    return (
      this.db.prepare("DELETE FROM model_credentials WHERE provider=?").run(provider).changes === 1
    );
  }
}

export const modelCredentialSchema = `
CREATE TABLE model_credentials (
  provider TEXT PRIMARY KEY,
  api_key TEXT NOT NULL CHECK(length(api_key) > 0),
  updated_at INTEGER NOT NULL
);
`;
