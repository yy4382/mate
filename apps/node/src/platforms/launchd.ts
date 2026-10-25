import { spawnSync } from "node:child_process";
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { EXIT_DO_NOT_RESTART } from "./types.ts";
import {
  fileLogs,
  markedFileOwnership,
  reportToStderr,
  writeServiceFile,
  xmlText,
} from "./service-files.ts";
import type { BundleLayout, Layout, ServiceManager, ServiceState } from "./types.ts";

const LABEL = "io.mate.node";
const MARKER = "<!-- Written by mate node. -->";

function launchctl(...args: string[]): string {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(
      `launchctl ${args.join(" ")} failed: ${detail}. Mate needs this account's launchd user manager in a graphical login session.`,
    );
  }
  return result.stdout;
}

export function launchd(paths: Layout, bundle: BundleLayout): ServiceManager {
  const domain = `gui/${process.getuid!()}`;
  const target = `${domain}/${LABEL}`;
  const log = join(paths.data, "node.log");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
${MARKER}
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xmlText(join(paths.program, bundle.runtime))}</string>
    <string>${xmlText(join(paths.program, "lib/mate.mjs"))}</string>
    <string>node</string><string>run</string><string>--service</string>
  </array>
  <key>Disabled</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ExitTimeOut</key><integer>45</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xmlText(log)}</string>
  <key>StandardErrorPath</key><string>${xmlText(log)}</string>
</dict></plist>
`;

  function read() {
    launchctl("print", domain);
    const disabled = launchctl("print-disabled", domain);
    const override = /"io\.mate\.node"\s*=>\s*(true|false)/.exec(disabled)?.[1];
    const result = spawnSync("launchctl", ["print", target], { encoding: "utf8" });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0 && result.status !== 113) {
      throw new Error(`launchctl could not inspect ${target}: ${result.stderr.trim()}`);
    }
    const loaded = result.status === 0;
    let ownership = markedFileOwnership(paths.unit, MARKER);
    const definition = /^\s*path = (.+)$/m.exec(result.stdout)?.[1];
    if (loaded && definition !== paths.unit) ownership = "foreign";
    const enabled = override === "false";
    const stateName = /^\s*state = (.+)$/m.exec(result.stdout)?.[1];
    const pid = Number(/^\s*pid = (\d+)$/m.exec(result.stdout)?.[1] ?? 0);
    let activity: ServiceState["activity"];
    if (!loaded) activity = enabled ? "starting" : "stopped";
    else if (stateName === "running" && pid > 0) activity = "running";
    else if (stateName === "waiting" || stateName === "not running")
      activity = enabled ? "starting" : "stopped";
    else activity = "unknown";
    const state: ServiceState = {
      ownership,
      loaded,
      enabled,
      activity,
      description: `${loaded ? (stateName ?? "unknown") : "not loaded"}, ${enabled ? "enabled" : "disabled"}`,
    };
    return { state, pid };
  }

  function requireOwned(): ServiceState {
    const { state } = read();
    if (state.ownership === "foreign")
      throw new Error(`${paths.unit} is not Mate's service; it was left alone.`);
    return state;
  }

  function stop(): string[] {
    const state = requireOwned();
    if (state.ownership === "absent" && !state.loaded && !state.enabled)
      return ["No node service is installed; nothing to stop."];
    launchctl("disable", target);
    if (state.loaded) launchctl("bootout", target);
    return ["Stopped and disabled the node service; it stays stopped until `mate node start`."];
  }

  return {
    inspect: () => read().state,
    install() {
      const { state } = read();
      if (state.ownership === "foreign")
        return [`Left ${paths.unit} alone: Mate did not write it.`];
      return writeServiceFile(paths.unit, plist) ? [`Wrote ${paths.unit}.`] : [];
    },
    uninstall() {
      const { state } = read();
      if (state.ownership === "foreign")
        return [`Left ${paths.unit} and the service it defines alone: Mate did not write it.`];
      const report: string[] = [];
      if (state.loaded || state.enabled) report.push(...stop());
      if (state.ownership === "mate") {
        unlinkSync(paths.unit);
        report.push(`Removed ${paths.unit}.`);
      }
      return report;
    },
    start() {
      const state = requireOwned();
      if (state.ownership === "absent")
        throw new Error(`${paths.unit} is missing; run \`mate node install <bundle>\` again.`);
      mkdirSync(paths.data, { recursive: true, mode: 0o700 });
      launchctl("enable", target);
      if (!state.loaded) launchctl("bootstrap", domain, paths.unit);
      else if (state.activity !== "running") launchctl("kickstart", target);
      return ["Started and enabled the node service; it starts again when this account logs in."];
    },
    stop,
    logs: (lines, follow) => fileLogs(log, lines, follow),
    ownsProcess(pid) {
      const current = read();
      return (
        current.state.ownership === "mate" &&
        current.state.activity === "running" &&
        current.pid === pid
      );
    },
    exitCode: (code) => (code === EXIT_DO_NOT_RESTART ? 0 : code),
    report: reportToStderr,
  };
}
