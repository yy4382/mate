import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, win32 } from "node:path";
import {
  lstatOrUndefined,
  markedFileOwnership,
  writeServiceFile,
  xmlText,
} from "./service-files.ts";
import type { BundleLayout, Layout, ServiceManager, ServiceState } from "./types.ts";

const MARKER = "Written by mate node.";
const QUERY = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$name = 'Mate node ' + $sid
$scheduler = New-Object -ComObject 'Schedule.Service'
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
$task = $null
foreach ($candidate in $folder.GetTasks(1)) {
  if ($candidate.Name -ceq $name) { $task = $candidate; break }
}
$record = $null
$processes = @()
if ($null -ne $task) {
  $definition = $task.Definition
  $instances = @($task.GetInstances(0) | ForEach-Object { [int]$_.EnginePID })
  $record = @{
    state = [int]$task.State
    enabled = [bool]$task.Enabled
    description = $definition.RegistrationInfo.Description
    instances = $instances
  }
  $pending = $instances
  $seen = @{}
  while ($pending.Count -gt 0) {
    $filter = ($pending | ForEach-Object { "ProcessId = $_ OR ParentProcessId = $_" }) -join ' OR '
    $pending = @()
    foreach ($process in Get-CimInstance Win32_Process -Filter $filter) {
      $pidValue = [int]$process.ProcessId
      if ($seen.ContainsKey($pidValue)) { continue }
      $seen[$pidValue] = $true
      $pending += $pidValue
      $processes += @{
        pid = $pidValue
        parent = [int]$process.ParentProcessId
        executable = $process.ExecutablePath
        created = $(if ($null -ne $process.CreationDate) { $process.CreationDate.ToUniversalTime().ToString('o') } else { $null })
      }
    }
  }
}
@{ name = $name; sid = $sid; task = $record; processes = $processes } | ConvertTo-Json -Depth 6 -Compress
`;

type ProcessInfo = {
  pid: number;
  parent: number;
  executable: string | null;
  created: string | null;
};

type Snapshot = {
  name: string;
  sid: string;
  task: null | {
    state: number;
    enabled: boolean;
    description: string;
    instances: number[];
  };
  processes: ProcessInfo[];
};

function powershell(script: string): string {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`The Windows Task Scheduler user manager could not be queried: ${detail}`);
  }
  return result.stdout;
}

function schtasks(...args: string[]): void {
  const result = spawnSync("schtasks.exe", args, { encoding: "utf8", windowsHide: true });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`schtasks ${args.join(" ")} failed: ${detail}`);
  }
}

function samePath(left: string | null, right: string): boolean {
  return (
    left !== null && win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
  );
}

function quotedArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export function scheduler(paths: Layout, bundle: BundleLayout): ServiceManager {
  const runtime = join(paths.program, bundle.runtime);
  const script = join(paths.program, "lib/mate.mjs");
  const argumentsText = `${quotedArgument(script)} node run --service`;
  const log = join(paths.data, "node.log");

  function read() {
    const snapshot = JSON.parse(powershell(QUERY)) as Snapshot;
    const task = snapshot.task;
    let ownership = markedFileOwnership(paths.unit, `<!-- ${MARKER} -->`);
    if (task !== null) {
      const owned = task.description === MARKER;
      if (!owned || ownership === "foreign") ownership = "foreign";
      else ownership = "mate";
    }
    let activity: ServiceState["activity"] = "stopped";
    if (task !== null) {
      if (task.state === 4 || task.instances.length > 0) activity = "running";
      else if (task.state === 2 || task.enabled) activity = "starting";
      else if (task.state !== 1 && task.state !== 3) activity = "unknown";
    }
    const names: Record<number, string> = {
      0: "unknown",
      1: "disabled",
      2: "queued",
      3: "ready",
      4: "running",
    };
    const state: ServiceState = {
      ownership,
      loaded: task !== null,
      enabled: task?.enabled ?? false,
      activity,
      description:
        task === null
          ? "not installed"
          : `${names[task.state] ?? "unknown"}, ${task.enabled ? "enabled" : "disabled"}`,
    };
    return { snapshot, state };
  }

  function processInstance(
    snapshot: Snapshot,
    process: ProcessInfo,
    since: string,
  ): number | undefined {
    if (!samePath(process.executable, runtime) || process.created === null) return undefined;
    const created = Date.parse(process.created);
    if (!Number.isFinite(created) || created > Date.parse(since)) return undefined;
    const byPid = new Map(snapshot.processes.map((entry) => [entry.pid, entry]));
    const visited = new Set<number>();
    let ancestor: ProcessInfo | undefined = process;
    while (ancestor !== undefined && !visited.has(ancestor.pid)) {
      const instance = snapshot.task?.instances.find((pid) => pid === ancestor!.pid);
      if (instance !== undefined) return instance;
      visited.add(ancestor.pid);
      const parent = byPid.get(ancestor.parent);
      if (
        parent?.created === null ||
        parent === undefined ||
        ancestor.created === null ||
        Date.parse(parent.created) > Date.parse(ancestor.created)
      )
        return undefined;
      ancestor = parent;
    }
    return undefined;
  }

  function stop(): string[] {
    const before = read();
    if (before.state.ownership === "foreign")
      throw new Error(`${paths.unit} is not Mate's service; it was left alone.`);
    if (!before.state.loaded) return ["No node service is installed; nothing to stop."];
    schtasks("/Change", "/TN", before.snapshot.name, "/DISABLE");
    const { snapshot, state } = read();
    if (state.ownership === "foreign")
      throw new Error("The task definition changed while stopping; its process was left alone.");
    for (const instance of snapshot.task?.instances ?? []) {
      const process = snapshot.processes.find(
        (entry) => processInstance(snapshot, entry, new Date().toISOString()) === instance,
      );
      if (process === undefined)
        throw new Error(
          "The node task is running, but its process identity could not be verified. It is now disabled; its process and program were left in place.",
        );
      const killed = spawnSync("taskkill.exe", ["/PID", String(process.pid), "/T", "/F"], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (killed.error !== undefined || killed.status !== 0)
        throw new Error(
          `Could not stop the node process tree: ${killed.error?.message ?? (killed.stderr.trim() || killed.stdout.trim())}. The task is disabled; its program was left in place.`,
        );
    }
    if (state.activity !== "stopped") {
      let endError;
      try {
        schtasks("/End", "/TN", snapshot.name);
      } catch (error) {
        endError = error;
      }
      if (read().state.activity !== "stopped")
        throw (
          endError ?? new Error("The node task has not stopped; its program was left in place.")
        );
    }
    return ["Stopped and disabled the node service; it stays stopped until `mate node start`."];
  }

  return {
    inspect: () => read().state,
    install() {
      const { snapshot, state } = read();
      if (state.ownership === "foreign")
        return [`Left ${paths.unit} and ${snapshot.name} alone: Mate did not write them.`];
      const task = `<?xml version="1.0" encoding="UTF-16"?>
<!-- ${MARKER} -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${MARKER}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xmlText(snapshot.sid)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Account"><UserId>${xmlText(snapshot.sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>false</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Account"><Exec><Command>${xmlText(runtime)}</Command><Arguments>${xmlText(argumentsText)}</Arguments><WorkingDirectory>${xmlText(paths.program)}</WorkingDirectory></Exec></Actions>
</Task>
`;
      const report: string[] = [];
      const bytes = Buffer.from(`\uFEFF${task}`, "utf16le");
      if (writeServiceFile(paths.unit, bytes)) report.push(`Wrote ${paths.unit}.`);
      if (state.activity === "stopped") {
        schtasks("/Create", "/TN", snapshot.name, "/XML", paths.unit, "/F");
        report.push(`Registered ${snapshot.name}; it is disabled until \`mate node start\`.`);
      }
      return report;
    },
    uninstall() {
      const { snapshot, state } = read();
      if (state.ownership === "foreign")
        return [`Left ${paths.unit} and the service it defines alone: Mate did not write it.`];
      const report: string[] = [];
      if (state.loaded) {
        report.push(...stop());
        schtasks("/Delete", "/TN", snapshot.name, "/F");
      }
      if (markedFileOwnership(paths.unit, `<!-- ${MARKER} -->`) === "mate") {
        unlinkSync(paths.unit);
        report.push(`Removed ${paths.unit}.`);
      }
      return report;
    },
    start() {
      const { snapshot, state } = read();
      if (state.ownership === "foreign")
        throw new Error(`${paths.unit} is not Mate's service; it was left alone.`);
      if (!state.loaded)
        throw new Error("The Mate task is missing; run `mate node install <bundle>` again.");
      schtasks("/Change", "/TN", snapshot.name, "/ENABLE");
      if (state.activity !== "running") schtasks("/Run", "/TN", snapshot.name);
      return ["Started and enabled the node service; it starts again when this account logs in."];
    },
    stop,
    logs(lines, follow) {
      if (lstatOrUndefined(log) === undefined) {
        process.stdout.write(`No node log exists yet (${log}).\n`);
        return 0;
      }
      const script = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $inputData = $env:MATE_SERVICE_INPUT | ConvertFrom-Json; Get-Content -LiteralPath $inputData.path -Encoding UTF8 -Tail $inputData.lines ${follow ? "-Wait" : ""}`;
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          env: { ...process.env, MATE_SERVICE_INPUT: JSON.stringify({ path: log, lines }) },
          stdio: "inherit",
          windowsHide: true,
        },
      );
      if (result.error !== undefined) throw new Error(`PowerShell failed: ${result.error.message}`);
      return result.status ?? 1;
    },
    ownsProcess(pid, since) {
      const { snapshot, state } = read();
      if (state.ownership !== "mate" || state.activity !== "running") return false;
      const process = snapshot.processes.find((entry) => entry.pid === pid);
      return process !== undefined && processInstance(snapshot, process, since) !== undefined;
    },
    exitCode: (code) => code,
    report(message) {
      mkdirSync(paths.data, { recursive: true });
      appendFileSync(log, `${new Date().toISOString()} ${message}\n`);
    },
  };
}
