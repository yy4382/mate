import { Application } from "../application.js";
import type { ApplicationPorts } from "../application.js";
import type { Store } from "../storage/store.js";
import type { AgentDefinition, TeamSettings } from "../domain/agents.js";
import type { Worker } from "../runtime/supervisor.js";
import { LinuxUserBackend, type LinuxIdentity } from "../execution/linux-user.js";

/** Host facilities an embedded caller may replace; everything else comes from the assembly. */
export interface LocalApplicationPorts {
  backend?: ApplicationPorts["backend"];
  memoryRoots?: Record<string, string>;
  workerFactory?: (agent: AgentDefinition) => Worker;
}

/** The current user runs ordinary commands inside each Agent's own workspace. */
function localIdentities(memoryRoots: Record<string, string>): Record<string, LinuxIdentity> {
  const uid = process.getuid?.(),
    gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return {};
  return Object.fromEntries(
    Object.entries(memoryRoots).map(([agentId, home]) => [agentId, { uid, gid, home }]),
  );
}

/**
 * Local JSONL development entry (and the harness that embeds it): the same complete application
 * the daemon builds, with no external adapter. It owns no data directory, so the caller passes an
 * open store and, when the Agents need a private workspace, its memory roots and execution
 * identity. Agent sessions are registered by the caller that owns the store lifetime.
 */
export function localApplication(
  store: Store,
  settings: TeamSettings,
  ports: LocalApplicationPorts = {},
): Application {
  const memoryRoots = ports.memoryRoots ?? {};
  return Application.create({
    store,
    team: settings,
    local: { humans: [...settings.ownerUserIds], rooms: [] },
    ports: {
      backend: ports.backend ?? new LinuxUserBackend(localIdentities(memoryRoots)),
      memoryRoots,
      ...(ports.workerFactory ? { workerFactory: ports.workerFactory } : {}),
    },
  });
}
