import type { DaemonConfig } from '../daemon/config.js';
import { LinuxProcessManager } from '../execution/linux-processes.js';
import { lstatSync } from 'node:fs';

/** Stateful deployment probe. The service wrapper must first prove mate.service is stopped. */
export async function runOfflineProbe(config: DaemonConfig): Promise<{ roots: string[] }> {
  if (config.runtime.linuxUsers) {
    if (process.getuid?.() !== 0) throw new Error('Linux user offline probe requires root');
    const manager = new LinuxProcessManager(Object.fromEntries(Object.entries(config.runtime.linuxUsers).map(([id, user]) => [id, user.uid])));
    const roots: string[] = [];
    for (const [agentId, identity] of Object.entries(config.runtime.linuxUsers)) {
      manager.verifyQuota(agentId);
      const stat = lstatSync(identity.home);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== identity.uid || stat.gid !== identity.gid || (stat.mode & 0o777) !== 0o700) throw new Error(`Private Linux Agent home differs: ${agentId}`);
      roots.push(identity.home);
    }
    return { roots };
  }
  throw new Error('Debian Linux-user deployment configuration required');
}
