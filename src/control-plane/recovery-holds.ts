import type Database from "better-sqlite3";

/** A restored Agent cannot run until its node identity and local effects are reconciled. */
export const recoveryHoldSchemaV21 = `
CREATE TABLE owner_agent_recovery_holds (
  agent_id TEXT PRIMARY KEY REFERENCES owner_agents(id),
  reason TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export function holdAgentsForRecovery(
  database: Database.Database,
  agentIds: readonly string[],
  reason: string,
  now = Date.now(),
): void {
  database
    .transaction(() => {
      const insert =
        database.prepare(`INSERT INTO owner_agent_recovery_holds(agent_id,reason,updated_at)
      VALUES(?,?,?) ON CONFLICT(agent_id) DO UPDATE SET reason=excluded.reason,updated_at=excluded.updated_at`);
      for (const agentId of agentIds) insert.run(agentId, reason, now);
    })
    .immediate();
}

export function releaseRecoveredAgent(database: Database.Database, agentId: string): void {
  database.prepare("DELETE FROM owner_agent_recovery_holds WHERE agent_id=?").run(agentId);
}
