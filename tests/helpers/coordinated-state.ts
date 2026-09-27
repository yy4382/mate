import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OwnerAuth } from "../../src/control-plane/owner-auth.js";
import { loadOrCreateNodeIdentity } from "../../src/nodes/identity.js";
import { AgentProcessOperations } from "../../src/nodes/process-operations.js";
import { PrivilegedNodeOperations } from "../../src/nodes/privileged-operations.js";
import { LinuxWorkspaceExecutor } from "../../src/nodes/workspace-execution.js";

export interface TestCoordinatedPaths {
  controlPlaneDataDir: string;
  nodeDataDir: string;
  agentHomeRoot: string;
}

/** Build actual current-format SQLite stores and a cryptographically valid node identity. */
export function initializeCoordinatedRoots(paths: TestCoordinatedPaths): {
  nodeId: string;
  publicKey: string;
} {
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const owner = new OwnerAuth({ dataDir: paths.controlPlaneDataDir });
  const node = loadOrCreateNodeIdentity(paths.nodeDataDir).identity;
  owner.db
    .prepare("INSERT INTO nodes(id,public_key,paired_at) VALUES(?,?,?)")
    .run(node.id, node.publicKey, 1);
  owner.close();

  const processDb = new Database(join(paths.nodeDataDir, "agent-process-operations.sqlite"));
  new AgentProcessOperations(processDb, async () => ({ state: "succeeded", receipt: {} }));
  processDb.close();
  chmodSync(join(paths.nodeDataDir, "agent-process-operations.sqlite"), 0o600);
  const privilegedDb = new Database(join(paths.nodeDataDir, "privileged-operations.sqlite"));
  new PrivilegedNodeOperations(privilegedDb, node.id, node.publicKey, async () => ({ code: 0 }));
  privilegedDb.close();
  chmodSync(join(paths.nodeDataDir, "privileged-operations.sqlite"), 0o600);
  new LinuxWorkspaceExecutor(paths.agentHomeRoot, paths.nodeDataDir, {
    lookupIdentity: (agentId, homeRoot) => ({
      username: `mate_${agentId.replaceAll("-", "").slice(0, 27)}`,
      uid: 24_001,
      gid: 24_001,
      workspace: join(homeRoot, agentId),
      workspaceMarker: "a".repeat(64),
    }),
  });
  return { nodeId: node.id, publicKey: node.publicKey };
}
