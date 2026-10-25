import type { DatabaseSync } from "node:sqlite";
import { openControlTables, type ControlTables } from "@mate/control-store";
import { Migrations } from "@mate/migrations";
import type { NodeAccess } from "@mate/node-protocol";
import type { ProviderCredentials } from "@mate/runtime";
import { z } from "zod";

const ADMIN_TABLES: ControlTables = {
  module: "admin",
  migrations: new Migrations([
    {
      version: 1,
      sql: `
CREATE TABLE provider_credentials (
  provider TEXT PRIMARY KEY,
  api_key TEXT NOT NULL,
  base_url TEXT
) STRICT;
`,
    },
    {
      version: 2,
      sql: `
CREATE TABLE node_grants (
  agent_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, node_id)
) STRICT;
`,
    },
  ]),
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
 * Credentials and node grants share the admin module's control-store connection. Both are read for each request,
 * so a change applies to the next request without updating an open runtime.
 */
export class AdminStore {
  readonly #db: DatabaseSync;

  constructor(dataDirectory: string) {
    this.#db = openControlTables(dataDirectory, ADMIN_TABLES);
  }

  credentials(provider: string): ProviderCredentials | undefined {
    return Row.parse(
      this.#db
        .prepare("SELECT api_key, base_url FROM provider_credentials WHERE provider = ?")
        .get(provider),
    );
  }

  setCredentials(provider: string, credentials: ProviderCredentials): void {
    this.#db
      .prepare(
        `INSERT INTO provider_credentials (provider, api_key, base_url) VALUES (?, ?, ?)
         ON CONFLICT (provider) DO UPDATE SET api_key = excluded.api_key, base_url = excluded.base_url`,
      )
      .run(provider, credentials.apiKey, credentials.baseUrl ?? null);
  }

  deleteCredentials(provider: string): void {
    this.#db.prepare("DELETE FROM provider_credentials WHERE provider = ?").run(provider);
  }

  nodeAccess(agentId: string, homeNodeId: string, targetNodeId: string): NodeAccess | undefined {
    if (targetNodeId === homeNodeId) return "home";
    const grant = this.#db
      .prepare("SELECT 1 FROM node_grants WHERE agent_id = ? AND node_id = ?")
      .get(agentId, targetNodeId);
    return grant === undefined ? undefined : "visit";
  }

  grantNode(agentId: string, nodeId: string, grantedAt: number): void {
    this.#db
      .prepare(
        `INSERT INTO node_grants (agent_id, node_id, granted_at) VALUES (?, ?, ?)
         ON CONFLICT (agent_id, node_id) DO NOTHING`,
      )
      .run(agentId, nodeId, grantedAt);
  }

  revokeNode(agentId: string, nodeId: string): void {
    this.#db
      .prepare("DELETE FROM node_grants WHERE agent_id = ? AND node_id = ?")
      .run(agentId, nodeId);
  }

  deleteNodeGrants(agentId: string): void {
    this.#db.prepare("DELETE FROM node_grants WHERE agent_id = ?").run(agentId);
  }

  close(): void {
    this.#db.close();
  }
}
