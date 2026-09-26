import type { HostOperations } from "./host.js";

type MaintenanceHost = Pick<HostOperations, "platform" | "euid" | "run" | "processes">;
const systemctl = "/usr/bin/systemctl";
const services = ["mate-node.service", "mate-control-plane.service"] as const;
const agentScope = /^mate-agent-[1-9][0-9]*-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.scope$/;

/** Stop both services and every managed Agent scope, then prove no scoped process survives. */
export function stopForCoordinatedMaintenance(host: MaintenanceHost): void {
  if (host.platform !== "linux" || host.euid() !== 0)
    throw new Error("Coordinated maintenance requires Linux root");
  stop(host, services[0]);
  const listed = host.run(systemctl, [
    "list-units",
    "--all",
    "--type=scope",
    "--plain",
    "--no-legend",
    "mate-agent-*.scope",
  ]);
  if (listed.code !== 0) throw new Error("Cannot enumerate Agent process scopes");
  const groups: string[] = [];
  for (const line of listed.stdout.split("\n").filter(Boolean)) {
    const unit = line.trim().split(/\s+/, 1)[0]!;
    if (!agentScope.test(unit)) throw new Error("Unexpected Agent process scope identity");
    const result = host.run(systemctl, ["show", unit, "-p", "ControlGroup", "--value"]);
    if (result.code !== 0) throw new Error(`Cannot inspect ${unit} cgroup`);
    const group = result.stdout.trim();
    if (group) groups.push(group);
    stop(host, unit);
  }
  stop(host, services[1]);
  for (const unit of services) {
    const result = host.run(systemctl, ["show", unit, "-p", "ActiveState", "--value"]);
    if (result.code !== 0 || result.stdout.trim() !== "inactive")
      throw new Error(`${unit} is not confirmed inactive`);
  }
  for (const group of groups)
    if (host.processes.pids(group).length > 0)
      throw new Error("Agent process is still running after the maintenance stop");
  const remaining = host.run(systemctl, [
    "list-units",
    "--state=active",
    "--type=scope",
    "--plain",
    "--no-legend",
    "mate-agent-*.scope",
  ]);
  if (remaining.code !== 0 || remaining.stdout.trim())
    throw new Error("Agent process scopes are not confirmed stopped");
}

function stop(host: MaintenanceHost, unit: string): void {
  const result = host.run(systemctl, ["stop", unit], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`Cannot stop ${unit}: ${result.stderr.slice(0, 200)}`);
}
