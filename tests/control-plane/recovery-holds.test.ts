import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { OwnerAuth } from "../../src/control-plane/owner-auth.js";
import {
  holdAgentsForRecovery,
  releaseRecoveredAgent,
} from "../../src/control-plane/recovery-holds.js";

it("persists per-Agent recovery holds across control-plane reopen and releases only proven identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "mate-recovery-holds-"));
  try {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const node = "33333333-3333-4333-8333-333333333333";
    let auth = new OwnerAuth({ dataDir: directory });
    auth.db.prepare("INSERT INTO nodes(id,public_key,paired_at) VALUES(?,?,?)").run(node, "key", 1);
    for (const id of [first, second])
      auth.db
        .prepare(
          `INSERT INTO owner_agents(id,node_id,name,role,description,provider,model_id,
        request_hash,provision_request_id,stage,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'complete',1,1)`,
        )
        .run(id, node, id, "", "", "openai", "model", "a".repeat(64), id);
    holdAgentsForRecovery(auth.db, [first, second], "checkpoint_reconciliation_pending");
    auth.close();
    auth = new OwnerAuth({ dataDir: directory });
    expect(
      auth.db.prepare("SELECT agent_id FROM owner_agent_recovery_holds ORDER BY agent_id").all(),
    ).toEqual([{ agent_id: first }, { agent_id: second }]);
    releaseRecoveredAgent(auth.db, second);
    expect(auth.db.prepare("SELECT agent_id FROM owner_agent_recovery_holds").all()).toEqual([
      { agent_id: first },
    ]);
    auth.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
