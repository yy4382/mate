import type { DaemonConfig } from "../daemon/config.js";
import type { HostOperations } from "./host.js";
import { assertAgentWorkspace, hostProcessManager, hostRules } from "./host-rules.js";

/** Stateful deployment probe. The service wrapper must first prove mate.service is stopped. */
export async function runOfflineProbe(
  host: HostOperations,
  config: DaemonConfig,
): Promise<{ roots: string[] }> {
  if (!config.runtime.linuxUsers)
    throw new Error("Debian Linux-user deployment configuration required");
  if (host.euid() !== 0) throw new Error("Linux user offline probe requires root");
  const rules = hostRules(config),
    manager = hostProcessManager(host, rules),
    roots: string[] = [];
  for (const agent of rules.agents) {
    await manager.verifyQuota(agent.identity.agentId);
    await assertAgentWorkspace(host, rules, agent);
    roots.push(agent.identity.home);
  }
  return { roots };
}
