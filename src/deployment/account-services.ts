import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { processIsRunning, processStartToken } from "../execution/linux-processes.js";

/** The two long-lived processes the owner starts under their own existing Linux account. */
export type AccountServiceName = "control-plane" | "node";

export const accountServiceNames: readonly AccountServiceName[] = ["control-plane", "node"];

/** How much of a log a diagnostic reads; the tail is what an owner needs after a failure. */
const logTailBytes = 65_536;
const stopPollIntervalMs = 25;
const defaultStopTimeoutMs = 15_000;
const defaultReadinessTimeoutMs = 30_000;
const startupStopTimeoutMs = 5_000;
/** How long a freshly started service keeps being probed after it printed its readiness line. */
const readinessProbeTimeoutMs = 2_000;

/**
 * What one service really is right now. `exited` and `failed` carry the evidence Mate observed;
 * `unconfirmed` is used only by a stop, and means the process was still there after the stop
 * attempt. Nothing here reports a service as stopped or healthy because it was asked to be.
 */
export type AccountServiceState =
  | { state: "not_running" }
  | { state: "running"; pid: number; startedAt: number }
  | {
      state: "exited";
      pid: number;
      code: number | null;
      signal: NodeJS.Signals | null;
      at: number;
      /** Present when Mate never observed an exit status for this process. */
      reason?: string;
    };

export interface AccountServiceRecord {
  pid: number;
  startedAt: number;
  startToken: string | undefined;
}

export interface AccountServiceConfig {
  /** Where the process records and logs live; both are private to the running account. */
  stateDir: string;
  /** The absolute entry file each service runs. */
  entries: Record<AccountServiceName, string>;
  /** Extra environment for one service, on top of the launching account's own environment. */
  environment?: Partial<Record<AccountServiceName, NodeJS.ProcessEnv>>;
  /**
   * The local endpoint that answers once a service is really serving, for the one service that has
   * one. A service with no probe is as ready as its own readiness line says it is.
   */
  probeUrls?: Partial<Record<AccountServiceName, string>>;
}

export interface AccountServiceStartOptions {
  /** How long a starting service has to print its readiness line. */
  readinessTimeoutMs?: number;
  /**
   * What a start request does about a service that is already running. `throw` (the default) keeps
   * `start` a request to change state; `skip` makes it "bring these services up", which is what
   * starting everything after an install needs.
   */
  onAlreadyRunning?: "throw" | "skip";
}

export interface AccountServiceStopOptions {
  /** How long a stop waits for the process to disappear before calling the result unconfirmed. */
  stopTimeoutMs?: number;
}

export interface AccountServiceStopReport {
  state: "stopped" | "not_running" | "unconfirmed";
  pid: number | null;
  /** The process that was still there when the stop could not be confirmed. */
  remaining?: number;
}

export interface AccountServiceStartReport {
  state: "running";
  pid: number;
  startedAt: number;
}

export interface AccountServiceRunResult {
  reports: Partial<
    Record<AccountServiceName, AccountServiceStartReport | AccountServiceStopReport>
  >;
}

/**
 * The readiness line each service prints when it is up. `MATE_CONTROL_PLANE_LISTENING` means the
 * control plane is serving HTTP; `MATE_NODE_PAIRED`/`MATE_NODE_CONNECTED` mean the node has an
 * authenticated session with a control plane, which is the only thing that makes it useful.
 */
const readiness: Record<AccountServiceName, RegExp> = {
  "control-plane": /MATE_CONTROL_PLANE_LISTENING \d+/,
  node: /MATE_NODE_(?:PAIRED|CONNECTED) [0-9a-f-]+/i,
};

/** A node that cannot authenticate will never become ready, so its start fails immediately. */
const fatalAtStartup =
  /配对令牌无效|控制面拒绝了此节点身份|requires MATE_NODE_PAIRING_TOKEN|没有可用的配对令牌/;

export function serviceLogPath(name: AccountServiceName, config: AccountServiceConfig): string {
  return join(resolve(config.stateDir), `${name}.log`);
}

export function serviceRecordPath(name: AccountServiceName, config: AccountServiceConfig): string {
  return join(resolve(config.stateDir), `${name}.json`);
}

/** Which service a log line came from, and where to read the rest of its output. */
export interface AccountServiceLogs {
  controlPlane: string;
  node: string;
}

/** The last bytes of one service's log, bounded so a diagnostic never prints an unbounded file. */
export function readServiceLog(name: AccountServiceName, config: AccountServiceConfig): string {
  // Logs name paths and carry service output, so reading them requires the same private state
  // directory the start and stop paths require; a diagnostic never reads a world-readable one.
  ensurePrivateStateDirectory(config);
  const path = serviceLogPath(name, config);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return "";
  }
  if (size === 0) return "";
  const start = Math.max(0, size - logTailBytes),
    descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(size - start),
      read = readSync(descriptor, buffer, 0, buffer.length, start);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Read what is recorded and check it against the host. A record whose PID no longer belongs to the
 * process it was written for — on Linux, a recycled PID — is not this service, and a service that
 * was already running through its readiness line stays `running` for the rest of its life because
 * a later log line is not evidence about the process.
 */
export function readServiceState(
  name: AccountServiceName,
  config: AccountServiceConfig,
): AccountServiceState {
  const record = readServiceRecord(name, config);
  if (!record) return { state: "not_running" };
  // An observed exit is the strongest evidence there is, and it outlives the PID check: a dead
  // process whose record still names a live recycled PID is not this service either way.
  const running = processIsRunning(record.pid, record.startToken),
    exit = readExit(name, config);
  if (exit && !running) return { state: "exited", pid: record.pid, ...exit };
  if (running) return { state: "running", pid: record.pid, startedAt: record.startedAt };
  return {
    state: "exited",
    pid: record.pid,
    code: null,
    signal: null,
    at: record.startedAt,
    reason: "Mate 未观察到退出状态；进程已不在运行。",
  };
}

export interface StoredServiceRecord extends AccountServiceRecord {
  /** The observed exit, or why the start gave up; absent until one of those happened. */
  exit?: { code: number | null; signal: NodeJS.Signals | null; at: number; reason?: string } | null;
}

export function readServiceRecord(
  name: AccountServiceName,
  config: AccountServiceConfig,
): StoredServiceRecord | undefined {
  const path = serviceRecordPath(name, config);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AccountServiceRecord> & { exit?: unknown };
    if (parsed === null || typeof parsed !== "object") return undefined;
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) < 1) return undefined;
    if (!Number.isSafeInteger(parsed.startedAt)) return undefined;
    const record: StoredServiceRecord = {
      pid: parsed.pid as number,
      startedAt: parsed.startedAt as number,
      startToken: typeof parsed.startToken === "string" ? parsed.startToken : undefined,
    };
    const exit = (parsed as { exit?: unknown }).exit as
      { code?: unknown; signal?: unknown; at?: unknown; reason?: unknown } | null | undefined;
    if (exit && typeof exit === "object")
      record.exit = {
        code: typeof exit.code === "number" ? exit.code : null,
        signal: typeof exit.signal === "string" ? (exit.signal as NodeJS.Signals) : null,
        at: typeof exit.at === "number" ? exit.at : record.startedAt,
        ...(typeof exit.reason === "string" ? { reason: exit.reason } : {}),
      };
    return record;
  } catch {
    return undefined;
  }
}

export interface AccountServiceReport {
  state: AccountServiceState["state"];
  pid: number | null;
  startedAt: number | null;
  summary: string;
  log: string;
}

/** One diagnostic report per service: the observed state plus a short human-readable summary. */
export function accountServiceReports(
  config: AccountServiceConfig,
  names: readonly AccountServiceName[] = accountServiceNames,
): Record<string, AccountServiceReport> {
  const reports: Record<string, AccountServiceReport> = {};
  for (const name of names) {
    const state = readServiceState(name, config);
    reports[name] = {
      state: state.state,
      pid: "pid" in state ? state.pid : null,
      startedAt: state.state === "running" ? state.startedAt : null,
      summary: describeServiceState(name, state),
      log: serviceLogPath(name, config),
    };
  }
  return reports;
}

function describeServiceState(name: AccountServiceName, state: AccountServiceState): string {
  const label = name === "control-plane" ? "控制面" : "节点";
  if (state.state === "not_running") return `${label}未在运行。`;
  if (state.state === "running") return `${label}进程 ${state.pid} 正在运行。`;
  return state.reason !== undefined
    ? `${label}进程 ${state.pid} 启动失败：${state.reason}`
    : `${label}进程 ${state.pid} 已退出（退出码 ${state.code ?? "未知"}，信号 ${state.signal ?? "无"}）。`;
}

/**
 * Start the named services as ordinary child processes of this account and wait until each prints
 * its readiness line. The child is detached and its output goes to a log file, so the services keep
 * running after this command exits and the owner can read what they said.
 *
 * A service that exits, or that cannot authenticate, fails its start with what it printed: Mate
 * never leaves a half-started service recorded as running.
 */
export async function startAccountServices(
  config: AccountServiceConfig,
  names: readonly AccountServiceName[] = accountServiceNames,
  options: AccountServiceStartOptions = {},
): Promise<AccountServiceRunResult> {
  const readinessTimeoutMs = options.readinessTimeoutMs ?? defaultReadinessTimeoutMs,
    reports: AccountServiceRunResult["reports"] = {};
  for (const name of names) {
    ensurePrivateStateDirectory(config);
    const current = readServiceState(name, config);
    if (current.state === "running") {
      if (options.onAlreadyRunning !== "skip")
        throw new Error(`${name} is already running as process ${current.pid}; stop it first.`);
      reports[name] = { state: "running", pid: current.pid, startedAt: current.startedAt };
      continue;
    }
    // Two starts racing would both see "not running" and both spawn a process; the record is the
    // shared state they race on, so it is claimed before spawning and released on failure.
    claimServiceRecord(name, config);
    let record: AccountServiceRecord;
    try {
      record = await startOne(name, config, readinessTimeoutMs);
    } catch (error) {
      releaseServiceClaim(name, config);
      throw error;
    }
    releaseServiceClaim(name, config);
    reports[name] = { state: "running", pid: record.pid, startedAt: record.startedAt };
  }
  return { reports };
}

/** Stop the named services, newest first, and report exactly what could be confirmed. */
export async function stopAccountServices(
  config: AccountServiceConfig,
  names: readonly AccountServiceName[] = accountServiceNames,
  options: AccountServiceStopOptions = {},
): Promise<AccountServiceRunResult> {
  const stopTimeoutMs = options.stopTimeoutMs ?? defaultStopTimeoutMs;
  const reports: AccountServiceRunResult["reports"] = {};
  // Callers pass services in start order (control plane first, so a node that reconnects finds it
  // listening). Stopping is the reverse of that order whatever the caller asked to stop, so a node
  // is never left talking to a control plane that has already gone away.
  const order = [...names].sort(
    (left, right) => accountServiceNames.indexOf(right) - accountServiceNames.indexOf(left),
  );
  for (const name of order) reports[name] = await stopOne(name, config, stopTimeoutMs);
  return { reports };
}

export async function restartAccountServices(
  config: AccountServiceConfig,
  names: readonly AccountServiceName[] = accountServiceNames,
  options: AccountServiceStartOptions & AccountServiceStopOptions = {},
): Promise<AccountServiceRunResult> {
  const stopped = await stopAccountServices(config, names, options);
  for (const [name, report] of Object.entries(stopped.reports))
    if (report?.state === "unconfirmed")
      throw new Error(
        `${name} 仍在运行（进程 ${(report as AccountServiceStopReport).remaining}），未重新启动；请先停掉它。`,
      );
  return startAccountServices(config, names, options);
}

async function startOne(
  name: AccountServiceName,
  config: AccountServiceConfig,
  readinessTimeoutMs: number,
): Promise<AccountServiceRecord> {
  const entry = resolve(config.entries[name]);
  if (!existsSync(entry)) throw new Error(`${name} entry file does not exist: ${entry}`);
  // Truncate rather than append: the readiness scan below must read this start's own output, and
  // an owner diagnosing a failure wants the run that failed, not months of history.
  const log = serviceLogPath(name, config),
    logDescriptor = openSync(log, "w", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [entry], {
      cwd: resolve(config.stateDir),
      env: { ...process.env, ...config.environment?.[name] },
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
  } finally {
    // The child holds its own copy of the descriptor, so the parent must not keep this one open.
    closeSync(logDescriptor);
  }
  const pid = child.pid;
  if (pid === undefined) {
    // No PID was reported, so there is nothing to record or signal; the child either failed to
    // start or is already gone, and this start's result is a definite failure either way.
    child.kill("SIGKILL");
    throw new Error(`${name} could not be started.`);
  }
  const record: AccountServiceRecord = {
    pid,
    startedAt: Date.now(),
    startToken: processStartToken(pid),
  };
  writeServiceRecord(name, config, { ...record, exit: null });
  child.unref();
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.once("error", () => resolveExit({ code: null, signal: null }));
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    },
  );
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  void exit.then((status) => {
    exited = status;
    // Keep the exit status with the record, so a service that dies later is still diagnosable.
    const current = readServiceRecord(name, config);
    if (current?.pid === pid)
      writeServiceRecord(name, config, { ...current, exit: { ...status, at: Date.now() } });
  });
  // A start that cannot show the service is up must not leave it running: the caller is told the
  // start failed, and a half-started process behind that message would be a service nobody tracks.
  // The record keeps why it failed, so a later `status` explains the same failure the start raised.
  const failure = async (reason: string): Promise<never> => {
    const stopped = !processIsRunning(pid, record.startToken)
      ? true
      : await killProcess(pid, record.startToken, startupStopTimeoutMs);
    // The exit observer may have recorded the child's own exit status in the meantime; keep that,
    // and add this reason, so `status` explains the same failure the start raised.
    const current = readServiceRecord(name, config);
    writeServiceRecord(name, config, {
      ...record,
      exit: { code: null, signal: null, at: Date.now(), ...current?.exit, reason },
    });
    throw new Error(stopped ? reason : `${reason}；并且无法确认已停掉它（进程 ${pid}）。`);
  };
  const deadline = Date.now() + readinessTimeoutMs;
  while (Date.now() < deadline) {
    if (exited)
      return failure(
        `${name} exited during startup (code ${exited.code ?? "unknown"}, signal ${exited.signal ?? "none"}): ${readServiceLog(name, config).trim().slice(-400)}`,
      );
    const output = readServiceLog(name, config);
    if (readiness[name].test(output)) {
      // A service that has printed its readiness line can still have a listening socket that is not
      // answering yet, so a start is only finished once the probe agrees it is serving. A probe that
      // never agrees is a failed start like any other, and goes through the same cleanup: the caller
      // is told the start failed, and the half-started process is not left behind.
      try {
        await probeReady(name, config);
      } catch (error) {
        return failure(error instanceof Error ? error.message : `${name} did not answer its probe`);
      }
      return record;
    }
    if (fatalAtStartup.test(output))
      return failure(`${name} did not become ready: ${output.trim().slice(-400)}`);
    await delay(stopPollIntervalMs);
  }
  return failure(`${name} did not become ready within ${readinessTimeoutMs}ms`);
}

async function stopOne(
  name: AccountServiceName,
  config: AccountServiceConfig,
  stopTimeoutMs: number,
): Promise<AccountServiceStopReport> {
  const record = readServiceRecord(name, config);
  if (!record) {
    rmSync(serviceRecordPath(name, config), { force: true });
    return { state: "not_running", pid: null };
  }
  if (!processIsRunning(record.pid, record.startToken)) {
    rmSync(serviceRecordPath(name, config), { force: true });
    return { state: "not_running", pid: record.pid };
  }
  const stopConfirmed = await killProcess(record.pid, record.startToken, stopTimeoutMs);
  if (stopConfirmed) {
    rmSync(serviceRecordPath(name, config), { force: true });
    return { state: "stopped", pid: record.pid };
  }
  return { state: "unconfirmed", pid: record.pid, remaining: record.pid };
}

/**
 * Signal one recorded process and wait for it to really disappear. SIGTERM first, then SIGKILL for
 * a process that ignored it. A process this account may not signal at all stays alive, and that is
 * exactly the outcome this returns false for: nothing here reports a stop it did not observe.
 */
async function killProcess(
  pid: number,
  startToken: string | undefined,
  timeoutMs: number,
): Promise<boolean> {
  // A recorded PID can be recycled, and signalling a recycled PID kills a stranger. Liveness is
  // checked with the recorded incarnation *before* the first signal, not only after it.
  if (!processIsRunning(pid, startToken)) return true;
  signalProcess(pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid, startToken)) return true;
    await delay(stopPollIntervalMs);
  }
  signalProcess(pid, "SIGKILL");
  const killDeadline = Date.now() + 2000;
  while (Date.now() < killDeadline) {
    if (!processIsRunning(pid, startToken)) return true;
    await delay(stopPollIntervalMs);
  }
  return false;
}

/**
 * Wait until a service that announced itself really answers. Only a service the caller gave a probe
 * endpoint is probed; one without a probe is already as ready as it can be observed to be.
 */
async function probeReady(name: AccountServiceName, config: AccountServiceConfig): Promise<void> {
  const url = config.probeUrls?.[name];
  if (!url) return;
  const deadline = Date.now() + readinessProbeTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      /* The socket exists but is not answering yet; keep trying until the probe deadline. */
    }
    await delay(stopPollIntervalMs);
  }
  throw new Error(`${name} printed its readiness line but did not answer ${url}`);
}

/** Only text this account's own processes printed is read back, so nothing here needs a parser. */
function readExit(
  name: AccountServiceName,
  config: AccountServiceConfig,
): { code: number | null; signal: NodeJS.Signals | null; at: number; reason?: string } | undefined {
  const record = readServiceRecord(name, config);
  if (!record?.exit) return undefined;
  return record.exit;
}

function writeServiceRecord(
  name: AccountServiceName,
  config: AccountServiceConfig,
  record: StoredServiceRecord,
): void {
  ensurePrivateStateDirectory(config);
  const path = serviceRecordPath(name, config),
    temporary = `${path}.${process.pid}.tmp`;
  // Write the whole record under a temporary name, then rename it into place: `rename` replaces the
  // old record atomically, so no crash or concurrent reader can see a missing or half-written file.
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "w" });
  renameSync(temporary, path);
}

/**
 * Take the one start slot for a service. The claim is an ordinary file created with `wx`, so two
 * concurrent `start` requests for the same service cannot both proceed: the loser is told the other
 * start is in progress instead of spawning a second process behind the first one's back.
 */
function claimServiceRecord(name: AccountServiceName, config: AccountServiceConfig): void {
  ensurePrivateStateDirectory(config);
  const path = serviceClaimPath(name, config),
    claim = () => {
      try {
        writeFileSync(path, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    };
  if (claim()) return;
  const owner = readFileSync(path, "utf8").trim(),
    ownerPid = Number(owner);
  if (owner !== "" && processIsRunning(ownerPid, processStartToken(ownerPid)))
    throw new Error(`${name} 正在被另一个进程启动（进程 ${owner}）；请稍后重试。`);
  // The claim's owner is gone, so this is a crashed start rather than a live one. Clearing it and
  // claiming again is the one race left, and it is settled by which creator wins the exclusive
  // create: only one of them can, and the others refuse instead of running a second copy.
  rmSync(path, { force: true });
  if (!claim())
    throw new Error(
      `${name} 正在被另一个进程启动（进程 ${readFileSync(path, "utf8").trim()}）；请稍后重试。`,
    );
}

function releaseServiceClaim(name: AccountServiceName, config: AccountServiceConfig): void {
  rmSync(serviceClaimPath(name, config), { force: true });
}

function serviceClaimPath(name: AccountServiceName, config: AccountServiceConfig): string {
  return join(resolve(config.stateDir), `${name}.starting`);
}

function ensurePrivateStateDirectory(config: AccountServiceConfig): void {
  const directory = resolve(config.stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // `mkdirSync` gives an existing directory its current mode and lets the umask narrow a new one,
  // so the private mode this release requires is set explicitly rather than requested.
  chmodSync(directory, 0o700);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Service state directory is not a real directory: ${directory}`);
  if ((stat.mode & 0o077) !== 0)
    throw new Error(`Service state directory is not private: ${directory}`);
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* The process is already gone; the liveness check above decides what that means. */
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** The running account's own name, as the host reports it. Mate never switches identity. */
export function currentAccountName(): string {
  try {
    return userInfo().username;
  } catch {
    return `uid-${typeof process.getuid === "function" ? process.getuid() : -1}`;
  }
}
