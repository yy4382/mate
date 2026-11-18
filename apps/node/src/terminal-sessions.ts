import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Clock } from "@palace/clock";
import {
  encodeTerminalOutcome,
  encodeTerminalWaitOutcome,
  type TerminalEnding,
  type TerminalExecArgs,
  type TerminalSettledOutcome,
  type TerminalWaitArgs,
  type TerminalWaitOutcome,
  type TerminalWriteArgs,
  type ToolResult,
} from "@palace/node-protocol";
import {
  Commands,
  drainExitGrace,
  EXIT_GRACE_MS,
  FramedMetadata,
  OutputBuffer,
  type Ending,
} from "./commands.ts";
import { currentPlatform } from "./platforms/index.ts";
import type { CommandProcess } from "./platforms/types.ts";
import { commandReplay } from "./shell-snapshot.ts";
import { Shells } from "./shells.ts";

const MAX_SETTLED = 256;
const MAX_CONSUMED = 1024;

type ExecCall = {
  readonly agentId: string;
  readonly conversationId?: number | undefined;
  readonly workspace: string;
  readonly arguments: TerminalExecArgs;
};

type SettledEntry = {
  readonly outcome: TerminalSettledOutcome;
  writeConsumed: boolean;
  readonly consumedConversations: Set<number | undefined>;
};

type Session = {
  readonly key: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly startedAt: number;
  readonly group: CommandProcess;
  readonly output: OutputBuffer;
  readonly metadata: FramedMetadata | undefined;
  readonly startDirectory: string;
  readonly shellsSessionKey: string | undefined;
  readonly timeoutMs: number | undefined;
  readonly timeoutAbort: AbortController;
  readonly graceAbort: AbortController;
  readonly exitPromise: Promise<Ending>;
  readonly stopFailed: PromiseWithResolvers<TerminalSettledOutcome>;
  lastStopFailure: SettledEntry | undefined;
  readonly openPipes: () => number;
  rawExit: Ending | undefined;
  forcedEnding: TerminalEnding | undefined;
  killing: boolean;
  updateRememberedDirectory: boolean;
  discardSettled: boolean;
  hasActiveWrite: boolean;
  activeWriteConversationId: number | undefined;
  settlePromise: Promise<TerminalSettledOutcome> | undefined;
  settledEntry: SettledEntry | undefined;
  waiters: {
    write?: ((outcome: TerminalSettledOutcome) => void) | undefined;
    readonly wait: Set<(entry: SettledEntry) => void>;
  };
  readonly killConsumers: Set<{ readonly conversationId: number | undefined }>;
  readonly observers: Set<() => void>;
};

/**
 * Stateful terminal sessions keyed by `(agentId, sessionId)`. Keeps live process handles, unread output buffers,
 * and bounded settled receipts across `terminal_exec`, `terminal_write`, and `terminal_wait`.
 */
export class TerminalSessions {
  readonly #commands: Commands;
  readonly #shells: Shells;
  readonly #clock: Clock;
  readonly #active = new Map<string, Session>();
  readonly #settled = new Map<string, SettledEntry>();
  readonly #killedBeforeStart = new Set<string>();

  constructor(commands: Commands, shells: Shells, clock: Clock) {
    this.#commands = commands;
    this.#shells = shells;
    this.#clock = clock;
  }

  async exec(
    call: ExecCall,
    onOutput: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const { agentId, workspace, arguments: args } = call;
    const key = sessionKey(agentId, args.sessionId);
    if (this.#active.has(key) || this.#settled.has(key)) {
      return failure(`Terminal session ${args.sessionId} already exists`);
    }
    if (this.#killedBeforeStart.delete(key) || signal.aborted) {
      return stoppedOutcome(args.sessionId);
    }

    const posix = process.platform !== "win32";
    const snapshot = posix ? await this.#shells.prepare(signal) : undefined;
    if (this.#killedBeforeStart.delete(key) || snapshot === "stopped" || signal.aborted) {
      return stoppedOutcome(args.sessionId);
    }
    if (snapshot !== undefined && !snapshot.ok) {
      return failure(
        `Shell initialization failed: ${snapshot.reason}. Restart the node after correcting its shell startup configuration.`,
      );
    }

    const notes: string[] = [];
    const shellsSessionKey =
      args.workdir === undefined && posix ? `${agentId}/${call.conversationId ?? ""}` : undefined;
    let startDirectory: string;
    if (args.workdir !== undefined) {
      startDirectory = isAbsolute(args.workdir) ? args.workdir : resolve(workspace, args.workdir);
      if (!isDirectory(startDirectory)) {
        return failure(`Working directory ${startDirectory} does not exist`);
      }
    } else if (shellsSessionKey !== undefined) {
      const resolved = this.#shells.resolveDirectory(shellsSessionKey, workspace);
      startDirectory = resolved.directory;
      if (resolved.note !== undefined) notes.push(resolved.note);
    } else {
      startDirectory = workspace;
    }

    const memoryDir = join(workspace, "memory");
    const env: NodeJS.ProcessEnv = posix
      ? { PALACE_MEMORY_DIR: memoryDir }
      : { ...process.env, PWD: startDirectory, HOME: workspace, PALACE_MEMORY_DIR: memoryDir };
    const launch =
      snapshot !== undefined && snapshot.ok
        ? commandReplay(snapshot.shell, snapshot.path, args.command)
        : undefined;

    let group: CommandProcess;
    try {
      group = currentPlatform().commands.start({
        command: args.command,
        cwd: startDirectory,
        env,
        ...(launch === undefined ? {} : { launch }),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return encodeTerminalOutcome({
        running: false,
        sessionId: args.sessionId,
        output: "",
        droppedBytes: 0,
        wallTimeMs: 0,
        ending: { kind: "not-started", reason },
        pipesHeld: false,
        backgroundRunning: false,
        ...(notes.length === 0 ? {} : { notes }),
      });
    }

    const startedAt = this.#clock.now();
    const shell = group.child;
    const output = new OutputBuffer();
    const detachStream = output.attach(onOutput);
    const metadata = launch === undefined ? undefined : new FramedMetadata(launch.metadata);
    group.metadata?.on("data", (chunk: Buffer) => metadata?.push(chunk));
    group.metadata?.on("error", () => {});
    group.metadata?.once("close", () => metadata?.close());

    let open = 2;
    for (const stream of [shell.stdout, shell.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => output.push(chunk));
      stream.once("close", () => open--);
    }

    let resolveRawExit!: (ending: Ending) => void;
    const exitPromise = new Promise<Ending>((res) => {
      resolveRawExit = res;
    });
    const session: Session = {
      key,
      agentId,
      sessionId: args.sessionId,
      startedAt,
      group,
      output,
      metadata,
      startDirectory,
      shellsSessionKey,
      timeoutMs: args.timeoutMs,
      timeoutAbort: new AbortController(),
      graceAbort: new AbortController(),
      exitPromise,
      stopFailed: Promise.withResolvers<TerminalSettledOutcome>(),
      lastStopFailure: undefined,
      openPipes: () => open,
      rawExit: undefined,
      forcedEnding: undefined,
      killing: false,
      updateRememberedDirectory: shellsSessionKey !== undefined,
      discardSettled: true,
      hasActiveWrite: false,
      activeWriteConversationId: undefined,
      settlePromise: undefined,
      settledEntry: undefined,
      waiters: { wait: new Set() },
      killConsumers: new Set(),
      observers: new Set(),
    };
    const recordExit = (ending: Ending) => {
      session.rawExit = ending;
      resolveRawExit(ending);
    };
    shell.once("error", (error) => recordExit({ kind: "not-started", reason: error.message }));
    shell.once("exit", (code, exitSignal) =>
      recordExit(
        exitSignal === null
          ? { kind: "exited", code: code ?? 0 }
          : { kind: "signaled", signal: exitSignal },
      ),
    );

    if (shell.pid === undefined) {
      const raw = await exitPromise;
      group.metadata?.destroy();
      detachStream();
      const drained = output.drain();
      return encodeTerminalOutcome({
        running: false,
        sessionId: args.sessionId,
        output: drained.text,
        droppedBytes: drained.droppedBytes,
        wallTimeMs: this.#clock.now() - startedAt,
        ending: toTerminalEnding(raw),
        pipesHeld: false,
        backgroundRunning: false,
        ...(notes.length === 0 ? {} : { notes }),
      });
    }

    this.#commands.track(group);
    this.#active.set(key, session);

    if (args.timeoutMs !== undefined) {
      void this.#clock.sleep(args.timeoutMs, session.timeoutAbort.signal).then(() => {
        if (!session.timeoutAbort.signal.aborted) {
          this.#terminate(session, { kind: "timed-out", timeoutMs: args.timeoutMs! });
        }
      });
    }

    const onExecAbort = () => {
      this.#terminate(session, { kind: "stopped" });
    };
    if (signal.aborted) onExecAbort();
    signal.addEventListener("abort", onExecAbort, { once: true });

    let yielded = false;
    if (args.yieldTimeMs === 0) {
      yielded = !signal.aborted && !session.killing && session.rawExit === undefined;
    } else if (!signal.aborted && !session.killing) {
      const yieldAbort = new AbortController();
      const outcome = await Promise.race([
        session.exitPromise.then(() => "done" as const),
        session.stopFailed.promise.then(() => "done" as const),
        this.#clock.sleep(args.yieldTimeMs, yieldAbort.signal).then(() => "yield" as const),
      ]);
      yieldAbort.abort();
      yielded =
        outcome === "yield" &&
        !signal.aborted &&
        !session.killing &&
        session.rawExit === undefined &&
        session.forcedEnding === undefined;
    }

    if (yielded) {
      signal.removeEventListener("abort", onExecAbort);
      session.discardSettled = false;
      session.updateRememberedDirectory = false;
      void this.#settleSession(session);
      detachStream();
      const drained = output.drain();
      return encodeTerminalOutcome({
        running: true,
        sessionId: args.sessionId,
        output: drained.text,
        droppedBytes: drained.droppedBytes,
        wallTimeMs: this.#clock.now() - startedAt,
        ...(notes.length === 0 ? {} : { notes }),
      });
    }

    try {
      const outcome = await Promise.race([
        this.#settleSession(session),
        session.stopFailed.promise,
      ]);
      detachStream();
      const mergedNotes = [...notes, ...(outcome.notes ?? [])];
      return encodeTerminalOutcome({
        ...outcome,
        ...(mergedNotes.length === 0 ? {} : { notes: mergedNotes }),
      });
    } finally {
      signal.removeEventListener("abort", onExecAbort);
    }
  }

  async write(
    call: {
      readonly agentId: string;
      readonly conversationId?: number | undefined;
      readonly arguments: TerminalWriteArgs;
    },
    onOutput: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const key = sessionKey(call.agentId, call.arguments.sessionId);
    const alreadySettled = this.#settled.get(key);

    if (call.arguments.kill === true) {
      if (alreadySettled !== undefined) {
        alreadySettled.consumedConversations.add(call.conversationId);
        if (!alreadySettled.writeConsumed) {
          alreadySettled.writeConsumed = true;
          return encodeTerminalOutcome(alreadySettled.outcome);
        }
        return encodeTerminalOutcome({
          ...alreadySettled.outcome,
          output: "",
          droppedBytes: 0,
        });
      }
      const session = this.#active.get(key);
      if (session === undefined) {
        this.#rememberKilledBeforeStart(key);
        return stoppedOutcome(call.arguments.sessionId);
      }
      if (signal.aborted) {
        return failure("Command write was stopped by its caller");
      }
      const consumer = { conversationId: call.conversationId };
      session.killConsumers.add(consumer);
      const onKillAbort = () => {
        if (session.settledEntry === undefined) {
          session.killConsumers.delete(consumer);
        }
      };
      signal.addEventListener("abort", onKillAbort, { once: true });
      try {
        session.updateRememberedDirectory = false;
        const finish = this.#settleSession(session);
        const stopFailure = this.#terminate(session, { kind: "killed" });
        if (stopFailure !== undefined) return encodeTerminalOutcome(stopFailure);
        const outcome = await raceAbort(finish, signal);
        if (outcome === "aborted") {
          return failure("Command write was stopped by its caller");
        }
        if (session.settledEntry !== undefined) {
          session.settledEntry.writeConsumed = true;
          session.settledEntry.consumedConversations.add(call.conversationId);
        }
        return encodeTerminalOutcome(outcome);
      } finally {
        signal.removeEventListener("abort", onKillAbort);
        session.killConsumers.delete(consumer);
      }
    }

    if (alreadySettled !== undefined) {
      if (alreadySettled.writeConsumed) {
        return failure(`Unknown or already finished terminal session: ${call.arguments.sessionId}`);
      }
      alreadySettled.writeConsumed = true;
      alreadySettled.consumedConversations.add(call.conversationId);
      const notes = [...(alreadySettled.outcome.notes ?? [])];
      if (call.arguments.chars !== undefined && call.arguments.chars.length > 0) {
        notes.push("[Process had already exited; stdin was not written]");
      }
      return encodeTerminalOutcome({
        ...alreadySettled.outcome,
        ...(notes.length === 0 ? {} : { notes }),
      });
    }

    const session = this.#active.get(key);
    if (session === undefined || session.discardSettled) {
      return failure(`Unknown or already finished terminal session: ${call.arguments.sessionId}`);
    }
    if (session.hasActiveWrite) {
      return failure(
        `Another write_stdin call is already active for terminal session ${call.arguments.sessionId}`,
      );
    }

    session.hasActiveWrite = true;
    session.activeWriteConversationId = call.conversationId;
    const detachStream = session.output.attach(onOutput);
    try {
      if (call.arguments.chars !== undefined && call.arguments.chars.length > 0) {
        if (!session.group.child.stdin.writableEnded && !session.group.child.stdin.destroyed) {
          session.group.child.stdin.write(call.arguments.chars);
        }
      }
      if (call.arguments.eof === true) {
        if (!session.group.child.stdin.writableEnded && !session.group.child.stdin.destroyed) {
          session.group.child.stdin.end();
        }
      }

      const settled = await this.#awaitWriteSettle(
        session,
        () => void this.#settleSession(session),
        call.arguments.yieldTimeMs,
        signal,
      );
      if (settled === "aborted") {
        return failure("Command write was stopped by its caller");
      }
      if (settled === "yield") {
        const drained = session.output.drain();
        return encodeTerminalOutcome({
          running: true,
          sessionId: session.sessionId,
          output: drained.text,
          droppedBytes: drained.droppedBytes,
          wallTimeMs: this.#clock.now() - session.startedAt,
        });
      }
      if (session.settledEntry !== undefined) {
        session.settledEntry.writeConsumed = true;
        session.settledEntry.consumedConversations.add(call.conversationId);
      }
      return encodeTerminalOutcome(settled);
    } finally {
      session.waiters.write = undefined;
      session.hasActiveWrite = false;
      session.activeWriteConversationId = undefined;
      detachStream();
    }
  }

  async wait(
    call: {
      readonly agentId: string;
      readonly conversationId?: number | undefined;
      readonly arguments: TerminalWaitArgs;
    },
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const key = sessionKey(call.agentId, call.arguments.sessionId);
    if (call.arguments.observeOnly === true) {
      const session = this.#active.get(key);
      if (session === undefined) {
        return encodeTerminalWaitOutcome({ consumed: true });
      }
      void this.#settleSession(session);
      const observed = await new Promise<boolean>((resolveObserve) => {
        const listener = () => {
          signal.removeEventListener("abort", onAbort);
          resolveObserve(true);
        };
        const onAbort = () => {
          session.observers.delete(listener);
          resolveObserve(false);
        };
        if (signal.aborted) {
          resolveObserve(false);
          return;
        }
        session.observers.add(listener);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return observed
        ? encodeTerminalWaitOutcome({ consumed: true })
        : failure("Session observation stopped");
    }

    const alreadySettled = this.#settled.get(key) ?? this.#active.get(key)?.lastStopFailure;
    if (alreadySettled !== undefined) {
      const consumed =
        alreadySettled.consumedConversations.has(call.conversationId) ||
        alreadySettled.consumedConversations.has(undefined);
      return encodeTerminalWaitOutcome(
        consumed ? { consumed: true } : { consumed: false, outcome: alreadySettled.outcome },
      );
    }

    const session = this.#active.get(key);
    if (session === undefined || session.discardSettled) {
      return failure(
        `Terminal session ${call.arguments.sessionId} was lost or does not exist on this node`,
      );
    }

    void this.#settleSession(session);
    const waitResult = await new Promise<SettledEntry | "aborted">((resolveWait) => {
      const listener = (entry: SettledEntry) => {
        signal.removeEventListener("abort", onAbort);
        resolveWait(entry);
      };
      const onAbort = () => {
        session.waiters.wait.delete(listener);
        resolveWait("aborted");
      };
      if (signal.aborted) {
        resolveWait("aborted");
        return;
      }
      session.waiters.wait.add(listener);
      signal.addEventListener("abort", onAbort, { once: true });
    });

    if (waitResult === "aborted") {
      if (session.waiters.wait.size === 0 && !session.hasActiveWrite) {
        session.discardSettled = true;
        const finish = this.#settleSession(session);
        if (this.#terminate(session, { kind: "stopped" }) === undefined) {
          await finish;
          this.#settled.delete(key);
        }
      }
      return failure(
        "Command was stopped: its caller stopped it or the connection to the node dropped",
      );
    }

    const consumed =
      waitResult.consumedConversations.has(call.conversationId) ||
      waitResult.consumedConversations.has(undefined);
    return encodeTerminalWaitOutcome(
      consumed ? { consumed: true } : { consumed: false, outcome: waitResult.outcome },
    );
  }

  /** Stop one active yielded session when the gateway cancels an in-flight call at its yield boundary. */
  stopSession(agentId: string, sessionId: string): void {
    const key = sessionKey(agentId, sessionId);
    const session = this.#active.get(key);
    if (session !== undefined) {
      session.discardSettled = true;
      session.updateRememberedDirectory = false;
      this.#terminate(session, { kind: "stopped" });
      void this.#settleSession(session);
    } else if (!this.#settled.has(key)) {
      this.#rememberKilledBeforeStart(key);
    }
  }

  /** Stop live detached sessions when the WebSocket connection drops and drop unconsumed receipts. */
  connectionClosed(): void {
    this.#settled.clear();
    this.#killedBeforeStart.clear();
    for (const session of this.#active.values()) {
      session.discardSettled = true;
      this.#terminate(session, { kind: "stopped" });
      void this.#settleSession(session);
    }
  }

  async #awaitWriteSettle(
    session: Session,
    trigger: () => void,
    yieldTimeMs: number | undefined,
    signal: AbortSignal,
  ): Promise<TerminalSettledOutcome | "yield" | "aborted"> {
    if (session.settledEntry !== undefined) {
      return session.settledEntry.outcome;
    }
    const yieldAbort = new AbortController();
    return new Promise((resolveWrite) => {
      const cleanup = () => {
        yieldAbort.abort();
        signal.removeEventListener("abort", onAbort);
        session.waiters.write = undefined;
      };
      const onAbort = () => {
        cleanup();
        resolveWrite("aborted");
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      session.waiters.write = (outcome) => {
        cleanup();
        resolveWrite(outcome);
      };
      trigger();
      if (session.settledEntry !== undefined) {
        const outcome = session.settledEntry.outcome;
        cleanup();
        resolveWrite(outcome);
        return;
      }
      if (yieldTimeMs === 0) {
        cleanup();
        resolveWrite("yield");
        return;
      }
      if (yieldTimeMs !== undefined) {
        void this.#clock.sleep(yieldTimeMs, yieldAbort.signal).then(() => {
          if (!yieldAbort.signal.aborted) {
            cleanup();
            resolveWrite("yield");
          }
        });
      }
    });
  }

  #terminate(session: Session, ending: TerminalEnding): TerminalSettledOutcome | undefined {
    if (session.rawExit !== undefined && session.group.background() === "finished") {
      session.graceAbort.abort();
      return;
    }
    if (session.killing) return;
    session.timeoutAbort.abort();
    const stopped = session.group.kill();
    if (!stopped.ok) {
      const failure: TerminalSettledOutcome = {
        running: false,
        sessionId: session.sessionId,
        output: session.output.text,
        droppedBytes: session.output.droppedBytes,
        wallTimeMs: this.#clock.now() - session.startedAt,
        ending: { kind: "stop-failed", reason: stopped.reason },
        pipesHeld: session.openPipes() > 0,
        backgroundRunning: session.group.background() === "running",
      };
      session.lastStopFailure = deliverOutcome(session, failure);
      session.stopFailed.resolve(failure);
      return failure;
    }
    session.killing = true;
    session.lastStopFailure = undefined;
    if (session.rawExit === undefined) session.forcedEnding = ending;
    else session.graceAbort.abort();
  }

  #settleSession(session: Session): Promise<TerminalSettledOutcome> {
    session.settlePromise ??= this.#finishSession(session);
    return session.settlePromise;
  }

  async #finishSession(session: Session): Promise<TerminalSettledOutcome> {
    const rawExit = await session.exitPromise;
    session.timeoutAbort.abort();

    let outcome: TerminalSettledOutcome;
    if (rawExit.kind === "not-started" && session.forcedEnding === undefined) {
      session.metadata && session.group.metadata?.destroy();
      session.group.child.stdin.destroy();
      this.#commands.untrack(session.group);
      const drained = session.output.drain();
      outcome = {
        running: false,
        sessionId: session.sessionId,
        output: drained.text,
        droppedBytes: drained.droppedBytes,
        wallTimeMs: this.#clock.now() - session.startedAt,
        ending: toTerminalEnding(rawExit),
        pipesHeld: false,
        backgroundRunning: false,
      };
    } else {
      let ending = session.forcedEnding ?? toTerminalEnding(rawExit);
      const alreadyKilled =
        ending.kind === "timed-out" ||
        ending.kind === "stopped" ||
        ending.kind === "killed" ||
        ending.kind === "stop-failed";

      const { pipesHeld, background } = await drainExitGrace({
        clock: this.#clock,
        group: session.group,
        openPipes: session.openPipes,
        metadataPending: () => session.metadata?.pending === true,
        alreadyKilled,
        signal: session.graceAbort.signal,
        onStopFailed: (reason) => {
          ending = { kind: "stop-failed", reason };
        },
      });
      let backgroundRunning = background === "running";
      if (backgroundRunning && session.lastStopFailure !== undefined) {
        const groupLifetime = new AbortController().signal;
        while (session.group.background() === "running") {
          await this.#clock.sleep(EXIT_GRACE_MS, groupLifetime);
        }
        backgroundRunning = false;
      }
      if (!backgroundRunning) this.#commands.untrack(session.group);

      let workingDirectory: string | undefined;
      if (
        session.updateRememberedDirectory &&
        session.shellsSessionKey !== undefined &&
        !alreadyKilled
      ) {
        workingDirectory = this.#shells.recordDirectory(
          session.shellsSessionKey,
          session.startDirectory,
          session.metadata?.record,
        );
      }

      const drained = session.output.drain();
      outcome = {
        running: false,
        sessionId: session.sessionId,
        output: drained.text,
        droppedBytes: drained.droppedBytes,
        wallTimeMs: this.#clock.now() - session.startedAt,
        ending,
        pipesHeld,
        backgroundRunning,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      };
    }

    this.#active.delete(session.key);
    const entry = deliverOutcome(session, outcome);
    session.settledEntry = entry;
    if (!session.discardSettled) {
      rememberBounded(this.#settled, session.key, entry, MAX_SETTLED);
    }
    const observers = [...session.observers];
    session.observers.clear();
    for (const notify of observers) notify();
    return outcome;
  }

  #rememberKilledBeforeStart(key: string): void {
    this.#killedBeforeStart.delete(key);
    this.#killedBeforeStart.add(key);
    if (this.#killedBeforeStart.size > MAX_CONSUMED) {
      const oldest = this.#killedBeforeStart.values().next().value;
      if (oldest !== undefined) this.#killedBeforeStart.delete(oldest);
    }
  }
}

function deliverOutcome(session: Session, outcome: TerminalSettledOutcome): SettledEntry {
  const consumedConversations = new Set([...session.killConsumers].map((c) => c.conversationId));
  if (session.waiters.write !== undefined) {
    consumedConversations.add(session.activeWriteConversationId);
    const notifyWrite = session.waiters.write;
    session.waiters.write = undefined;
    notifyWrite(outcome);
  }
  const entry = { outcome, consumedConversations, writeConsumed: consumedConversations.size > 0 };
  for (const listener of session.waiters.wait) listener(entry);
  session.waiters.wait.clear();
  return entry;
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | "aborted"> {
  if (signal.aborted) return Promise.resolve("aborted");
  const aborted = Promise.withResolvers<"aborted">();
  const onAbort = () => aborted.resolve("aborted");
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([promise, aborted.promise]).finally(() =>
    signal.removeEventListener("abort", onAbort),
  );
}

function sessionKey(agentId: string, sessionId: string): string {
  return `${agentId}\0${sessionId}`;
}

function stoppedOutcome(sessionId: string): ToolResult {
  return encodeTerminalOutcome({
    running: false,
    sessionId,
    output: "",
    droppedBytes: 0,
    wallTimeMs: 0,
    ending: { kind: "stopped" },
    pipesHeld: false,
    backgroundRunning: false,
  });
}

function toTerminalEnding(ending: Ending): TerminalEnding {
  switch (ending.kind) {
    case "timed-out":
      return { kind: "stopped" };
    default:
      return ending;
  }
}

function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function failure(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
