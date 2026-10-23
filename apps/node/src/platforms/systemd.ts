import { spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { EXIT_DO_NOT_RESTART } from "./service-constants.ts";
import { markedFileOwnership, reportToStderr, writeServiceFile } from "./service-files.ts";
import type { BundleLayout, Layout, ServiceManager, ServiceState } from "./types.ts";

const SERVICE = "mate-node.service";
const HEADER =
  "# Written by `mate node`, which replaces this file. Put local changes in a drop-in.";

function systemctl(...args: string[]): string {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(
      `systemctl --user ${args.join(" ")} failed: ${detail}. The node needs this account's systemd user manager; log in as this account, or enable linger for it.`,
    );
  }
  return result.stdout;
}

function quotedPath(path: string): string {
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

export function systemd(paths: Layout, bundle: BundleLayout): ServiceManager {
  const unit = `${HEADER}
[Unit]
Description=Mate node

[Service]
Type=exec
ExecStart=${quotedPath(join(paths.program, bundle.runtime))} ${quotedPath(join(paths.program, bundle.script))} node run --service
Restart=on-failure
RestartSec=5s
RestartPreventExitStatus=${EXIT_DO_NOT_RESTART}
KillMode=mixed
TimeoutStopSec=45s
UMask=0077

[Install]
WantedBy=default.target
`;

  function read() {
    const output = systemctl(
      "show",
      SERVICE,
      "--property=LoadState,ActiveState,UnitFileState,MainPID,FragmentPath",
    );
    const values = new Map<string, string>();
    for (const line of output.split("\n")) {
      const separator = line.indexOf("=");
      if (separator !== -1) values.set(line.slice(0, separator), line.slice(separator + 1));
    }
    const loaded = values.get("LoadState") === "loaded";
    const active = values.get("ActiveState") ?? "unknown";
    const enabled = values.get("UnitFileState") ?? "";
    const fragment = values.get("FragmentPath");
    let ownership = markedFileOwnership(paths.unit, `${HEADER}\n`);
    if (loaded && fragment !== paths.unit) ownership = "foreign";
    const activities: Record<string, ServiceState["activity"]> = {
      inactive: "stopped",
      failed: "stopped",
      activating: "starting",
      active: "running",
      reloading: "running",
      deactivating: "stopping",
    };
    const state: ServiceState = {
      ownership,
      loaded,
      enabled: enabled === "enabled",
      activity: activities[active] ?? "unknown",
      description: loaded ? `${active}, ${enabled || "unknown"}` : "not installed",
    };
    return { state, mainPid: Number(values.get("MainPID") ?? 0) };
  }

  function requireOwned(): ServiceState {
    const { state } = read();
    if (state.ownership === "foreign")
      throw new Error(`${paths.unit} is not Mate's service; it was left alone.`);
    return state;
  }

  return {
    inspect: () => read().state,
    install() {
      const { state } = read();
      if (state.ownership === "foreign")
        return [`Left ${paths.unit} alone: Mate did not write it.`];
      if (!writeServiceFile(paths.unit, unit)) return [];
      systemctl("daemon-reload");
      return [`Wrote ${paths.unit}.`];
    },
    uninstall() {
      const { state } = read();
      if (state.ownership === "foreign")
        return [`Left ${paths.unit} and the service it defines alone: Mate did not write it.`];
      const report: string[] = [];
      if (state.loaded) {
        systemctl("disable", "--now", SERVICE);
        report.push("The node service is stopped and disabled.");
      }
      if (state.ownership === "mate") {
        unlinkSync(paths.unit);
        systemctl("daemon-reload");
        report.push(`Removed ${paths.unit}.`);
      }
      return report;
    },
    start() {
      const state = requireOwned();
      if (state.ownership === "absent")
        throw new Error(`${paths.unit} is missing; run \`mate node install <bundle>\` again.`);
      systemctl("enable", "--now", SERVICE);
      return ["Started and enabled the node service; it starts again at login or boot."];
    },
    stop() {
      const state = requireOwned();
      if (!state.loaded) return ["No node service is installed; nothing to stop."];
      systemctl("disable", "--now", SERVICE);
      return ["Stopped and disabled the node service; it stays stopped until `mate node start`."];
    },
    logs(lines, follow) {
      const result = spawnSync(
        "journalctl",
        ["--user", "--unit", SERVICE, "--lines", String(lines), ...(follow ? ["--follow"] : [])],
        { stdio: "inherit" },
      );
      if (result.error !== undefined) throw new Error(`journalctl failed: ${result.error.message}`);
      return result.status ?? 1;
    },
    ownsProcess(pid) {
      const { state, mainPid } = read();
      return (
        state.ownership === "mate" && state.activity === "running" && mainPid > 0 && mainPid === pid
      );
    },
    exitCode: (code) => code,
    report: reportToStderr,
  };
}
