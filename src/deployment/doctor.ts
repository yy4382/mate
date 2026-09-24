import { join, resolve, sep } from "node:path";
import { slackRuntimeConfig, type DaemonConfig } from "../daemon/config.js";
import { managedLayout } from "./systemd.js";
import { verifyRelease } from "./release.js";
import type { HostOperations } from "./host.js";
import {
  assertAgentWorkspace,
  assertManagedEntry,
  controlEntries,
  hostRules,
} from "./host-rules.js";

export type DoctorStatus = "pass" | "fail" | "info";
export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}
export interface DoctorReport {
  version: 1;
  healthy: boolean;
  checks: DoctorCheck[];
}

function requiredSecretReferences(config: DaemonConfig): string[] {
  return [
    ...new Set([
      ...config.mate.agents.map((agent) => agent.model.apiKeyEnv),
      ...(config.adapters.slack?.bindings.flatMap((binding) => [
        binding.botTokenEnv,
        binding.appTokenEnv,
      ]) ?? []),
    ]),
  ].sort();
}

export interface DoctorOptions {
  releaseRoot?: string;
  requireSecrets?: boolean;
}

/** Verify Debian deployment facts through the replaceable host-operations entry. */
export async function runDoctor(
  host: HostOperations,
  config: DaemonConfig,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  if (!config.runtime.linuxUsers || !config.runtime.sharedRoot)
    throw new Error("Debian Linux-user deployment configuration required");
  const rules = hostRules(config);
  const checks: DoctorCheck[] = [];
  const check = async (
    name: string,
    action: () => string | Promise<string>,
    failure = true,
  ): Promise<void> => {
    try {
      checks.push({
        name,
        status: failure ? "pass" : "info",
        detail: await action(),
      });
    } catch (error) {
      checks.push({
        name,
        status: failure ? "fail" : "info",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
  await check("supported-runtime", async () => {
    if (host.platform !== "linux" || host.arch !== "x64" || !/^v24\./.test(host.node))
      throw new Error("Expected Debian deployment runtime: Linux x86_64 and Node 24");
    const values = Object.fromEntries(
      (await host.readText("/etc/os-release"))
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, "")];
        }),
    );
    if (values.ID !== "debian" || values.VERSION_ID !== "13")
      throw new Error("Only Debian 13 x86_64 is an accepted production baseline");
    return `Debian 13 ${host.arch}, ${host.node}, ABI ${host.modulesAbi}`;
  });
  await check("managed-layout", async () => {
    const entries = controlEntries(rules);
    for (const entry of entries) await assertManagedEntry(host, entry, rules);
    for (const agent of rules.agents) {
      await assertAgentWorkspace(host, rules, agent);
      await assertManagedEntry(host, agent.slice, rules);
    }
    return `${entries.length + rules.agents.length * 2} managed paths match the deployment rules`;
  });
  await check("release-identity", async () => {
    const current = await host.canonical(options.releaseRoot ?? managedLayout.current),
      prefix = `${managedLayout.releases}${sep}`;
    if (!current.startsWith(prefix))
      throw new Error("Current release escapes the managed release directory");
    const manifest = await verifyRelease(host, current, undefined, {
      platform: host.platform,
      arch: host.arch,
      node: host.node,
      modulesAbi: host.modulesAbi,
      packageManager: "pnpm@10.33.0",
    });
    if (resolve(managedLayout.releases, manifest.releaseId) !== current)
      throw new Error("Current release path does not match its content identity");
    for (const entry of manifest.inventory) {
      const stat = await host.lstat(join(current, entry.path));
      if (stat.uid !== 0 || (entry.type !== "symlink" && (stat.mode & 0o022) !== 0))
        throw new Error(`Release entry is not immutable root-owned content: ${entry.path}`);
    }
    const root = await host.lstat(current);
    if (root.uid !== 0 || (root.mode & 0o022) !== 0)
      throw new Error("Release root is not immutable root-owned content");
    return manifest.releaseId;
  });
  await check("linux-identities", async () => {
    for (const agent of rules.agents) {
      const identity = agent.identity;
      if (!identity.username)
        throw new Error(`${identity.agentId}: managed deployment requires a username`);
      const account = host.run("/usr/bin/getent", ["passwd", identity.username]),
        fields = account.stdout.trim().split(":");
      if (
        account.code !== 0 ||
        fields.length !== 7 ||
        Number(fields[2]) !== identity.uid ||
        Number(fields[3]) !== identity.gid ||
        fields[5] !== identity.home
      )
        throw new Error(`${identity.agentId}: Linux account differs from configuration`);
      if (host.run("/usr/bin/id", ["-G", identity.username!]).code !== 0)
        throw new Error(`${identity.agentId}: Linux groups are unavailable`);
      const slice = host.run("/usr/bin/systemctl", [
        "show",
        agent.sliceUnit,
        "-p",
        "LoadState",
        "-p",
        "MemoryMax",
        "-p",
        "TasksMax",
        "-p",
        "CPUQuotaPerSecUSec",
        "--no-pager",
      ]);
      const values = Object.fromEntries(
        slice.stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const at = line.indexOf("=");
            return [line.slice(0, at), line.slice(at + 1)];
          }),
      );
      if (
        slice.code !== 0 ||
        values.LoadState !== "loaded" ||
        !Number.isFinite(Number(values.MemoryMax)) ||
        Number(values.MemoryMax) < 1 ||
        !Number.isFinite(Number(values.TasksMax)) ||
        Number(values.TasksMax) < 1 ||
        !values.CPUQuotaPerSecUSec ||
        values.CPUQuotaPerSecUSec === "infinity"
      )
        throw new Error(`${identity.agentId}: finite process quotas are unavailable`);
    }
    return `${rules.agents.length} Linux identities, private homes and process slices checked`;
  });
  await check("system-approval", () => {
    const eligible = config.runtime.systemAgents ?? [];
    if (eligible.length) {
      const slack = slackRuntimeConfig(config);
      if (
        !slack?.ownerUserIds.length ||
        eligible.some(
          (id) => !config.adapters.slack?.bindings.some((binding) => binding.agentId === id),
        )
      )
        throw new Error(
          "System-eligible Agents need a mapped Slack owner and Agent installation for approval",
        );
    }
    return `${eligible.length} Agent(s) eligible to request individual owner-approved system commands`;
  });
  await check(
    "secret-references",
    () => {
      const missing = requiredSecretReferences(config).filter((name) => !process.env[name]?.trim());
      if (missing.length) throw new Error(`Missing environment references: ${missing.join(", ")}`);
      return "all referenced credentials are present";
    },
    options.requireSecrets !== false,
  );
  await check(
    "service-state",
    () => {
      const result = host.run("/usr/bin/systemctl", ["is-active", "mate.service"]);
      return result.code === 0 ? "active" : "inactive";
    },
    false,
  );
  return {
    version: 1,
    healthy: checks.every((item) => item.status !== "fail"),
    checks,
  };
}
