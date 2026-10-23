import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, win32 } from "node:path";
import { EXIT_DO_NOT_RESTART } from "./service-constants.ts";
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
  $principal = $definition.Principal.UserId
  if (-not $principal.StartsWith('S-1-')) {
    try {
      $principal = (New-Object Security.Principal.NTAccount($principal)).Translate([Security.Principal.SecurityIdentifier]).Value
    } catch { $principal = '' }
  }
  $actions = @($definition.Actions)
  $instances = @($task.GetInstances(0) | ForEach-Object { @{ id = $_.InstanceGuid; enginePid = [int]$_.EnginePID } })
  $record = @{
    state = [int]$task.State
    enabled = [bool]$task.Enabled
    principal = $principal
    logonType = [int]$definition.Principal.LogonType
    description = $definition.RegistrationInfo.Description
    command = $(if ($actions.Count -eq 1) { $actions[0].Path } else { '' })
    arguments = $(if ($actions.Count -eq 1) { $actions[0].Arguments } else { '' })
    instances = $instances
  }
  if ($instances.Count -gt 0) {
    $processes = @(Get-CimInstance Win32_Process | ForEach-Object {
      @{
        pid = [int]$_.ProcessId
        parent = [int]$_.ParentProcessId
        executable = $_.ExecutablePath
        commandLine = $_.CommandLine
        created = $(if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null })
      }
    })
  }
}
@{ name = $name; sid = $sid; task = $record; processes = $processes } | ConvertTo-Json -Depth 6 -Compress
`;

type ProcessInfo = {
  pid: number;
  parent: number;
  executable: string | null;
  commandLine: string | null;
  created: string | null;
};

type TaskInstance = { id: string; enginePid: number };

type Snapshot = {
  name: string;
  sid: string;
  task: null | {
    state: number;
    enabled: boolean;
    principal: string;
    logonType: number;
    description: string;
    command: string;
    arguments: string;
    instances: TaskInstance[];
  };
  processes: ProcessInfo[];
};

function powershell(script: string, input?: object): string {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: { ...process.env, MATE_SERVICE_INPUT: JSON.stringify(input ?? {}) },
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

function commandArguments(commandLine: string): string[] {
  const result: string[] = [];
  let argument = "";
  let quoted = false;
  for (let index = 0; index < commandLine.length; index += 1) {
    const character = commandLine[index]!;
    if (character === "\\") {
      let count = 1;
      while (commandLine[index + count] === "\\") count += 1;
      if (commandLine[index + count] === '"') {
        argument += "\\".repeat(Math.floor(count / 2));
        if (count % 2 === 0) quoted = !quoted;
        else argument += '"';
        index += count;
      } else {
        argument += "\\".repeat(count);
        index += count - 1;
      }
    } else if (character === '"') {
      quoted = !quoted;
    } else if (/\s/.test(character) && !quoted) {
      if (argument.length > 0) result.push(argument);
      argument = "";
    } else {
      argument += character;
    }
  }
  if (argument.length > 0) result.push(argument);
  return result;
}

export function scheduler(paths: Layout, bundle: BundleLayout): ServiceManager {
  const runtime = join(paths.program, bundle.runtime);
  const script = join(paths.program, bundle.script);
  const argumentsText = `${quotedArgument(script)} node run --service`;
  const log = join(paths.data, "node.log");

  function read() {
    const snapshot = JSON.parse(powershell(QUERY)) as Snapshot;
    const task = snapshot.task;
    let ownership = markedFileOwnership(paths.unit, `<!-- ${MARKER} -->`);
    if (task !== null) {
      const owned =
        task.principal === snapshot.sid &&
        task.logonType === 3 &&
        task.description === MARKER &&
        samePath(task.command, runtime) &&
        task.arguments === argumentsText;
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
  ): TaskInstance | undefined {
    if (
      !samePath(process.executable, runtime) ||
      process.commandLine === null ||
      process.created === null
    )
      return undefined;
    const created = Date.parse(process.created);
    if (!Number.isFinite(created) || created > Date.parse(since)) return undefined;
    const args = commandArguments(process.commandLine);
    if (
      args.length !== 5 ||
      !samePath(args[0]!, runtime) ||
      !samePath(args[1]!, script) ||
      args[2] !== "node" ||
      args[3] !== "run" ||
      args[4] !== "--service"
    )
      return undefined;
    const byPid = new Map(snapshot.processes.map((entry) => [entry.pid, entry]));
    const visited = new Set<number>();
    let ancestor: ProcessInfo | undefined = process;
    while (ancestor !== undefined && !visited.has(ancestor.pid)) {
      const instance = snapshot.task?.instances.find((entry) => entry.enginePid === ancestor!.pid);
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
    const handled = new Set<string>();
    const deadline = Date.now() + 15_000;
    while (true) {
      const { snapshot, state } = read();
      if (state.ownership === "foreign")
        throw new Error(
          "The task definition changed while stopping; its process and program were left in place.",
        );
      if (state.activity === "stopped") break;
      const instances = snapshot.task?.instances ?? [];
      for (const process of snapshot.processes) {
        const instance = processInstance(snapshot, process, new Date().toISOString());
        if (instance === undefined || handled.has(instance.id)) continue;
        const killed = spawnSync("taskkill.exe", ["/PID", String(process.pid), "/T", "/F"], {
          encoding: "utf8",
          windowsHide: true,
        });
        if (killed.error !== undefined) throw new Error(`taskkill failed: ${killed.error.message}`);
        if (killed.status !== 0) {
          throw new Error(
            `Could not confirm that the node process tree stopped: ${killed.stderr.trim() || killed.stdout.trim()}. The task is disabled; its program was left in place.`,
          );
        }
        handled.add(instance.id);
      }
      if (
        (state.activity === "running" && instances.length === 0) ||
        instances.some((instance) => !handled.has(instance.id))
      ) {
        throw new Error(
          "The node task is running, but its process identity could not be verified. It is now disabled; its process and program were left in place.",
        );
      }
      if (instances.length > 0) {
        try {
          schtasks("/End", "/TN", snapshot.name);
        } catch (error) {
          if (read().state.activity !== "stopped") throw error;
        }
      }
      if (state.activity === "unknown")
        throw new Error(
          "The node task state is unknown; its process and program were left in place.",
        );
      if (Date.now() >= deadline)
        throw new Error("The node task has not stopped; its program was left in place.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
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
    <RestartOnFailure><Interval>PT1M</Interval><Count>255</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Account"><Exec><Command>${xmlText(runtime)}</Command><Arguments>${xmlText(argumentsText)}</Arguments><WorkingDirectory>${xmlText(paths.program)}</WorkingDirectory></Exec></Actions>
</Task>
`;
      const report: string[] = [];
      const bytes = Buffer.from(`\uFEFF${task}`, "utf16le");
      if (writeServiceFile(paths.unit, bytes)) report.push(`Wrote ${paths.unit}.`);
      if (!state.loaded) {
        schtasks("/Create", "/TN", snapshot.name, "/XML", paths.unit);
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
    exitCode: (code) => (code === EXIT_DO_NOT_RESTART ? 0 : code),
    report(message) {
      mkdirSync(paths.data, { recursive: true });
      appendFileSync(log, `${new Date().toISOString()} ${message}\n`);
    },
  };
}
