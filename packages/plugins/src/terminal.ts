import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTask,
  defineTool,
  section,
  type ConversationId,
  type Cursor,
  type Extension,
} from "@earendil-works/pi-durable";
import {
  decodeTerminalOutcome,
  decodeTerminalWaitOutcome,
  EXEC_YIELD_MS,
  formatTerminalOutcome,
  TERMINAL_TIMEOUT_MS,
  WRITE_YIELD_MS,
  type TerminalExecArgs,
  type TerminalWaitArgs,
  type TerminalWriteArgs,
  type ToolResult,
} from "@palace/node-protocol";

export type TerminalPort = {
  exec(
    call: TerminalExecArgs & { readonly conversationId: ConversationId; readonly node?: string },
    onOutput: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ToolResult>;
  write(
    call: TerminalWriteArgs & { readonly conversationId: ConversationId },
    onOutput: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ToolResult>;
  wait(
    call: TerminalWaitArgs & { readonly conversationId: ConversationId },
    signal: AbortSignal,
  ): Promise<ToolResult>;
};

type WatchInput = { readonly sessionId: string; readonly command: string };
type WatchState = { readonly phase: "wait" };
type WatchResult = { readonly notified: boolean };

const STOPPED: ToolResult = {
  content: [
    {
      type: "text",
      text: "The call was stopped because the Agent was paused or shut down. Its effect is unknown; it was not retried.",
    },
  ],
  isError: true,
};

const TERMINAL_INSTRUCTIONS =
  "Run commands with exec_command. Long-running or interactive sessions yield once yield_time_ms expires " +
  "with running: true and a session_id you can pass to write_stdin to send input, close stdin (eof: true), " +
  "read incremental output, or terminate (kill: true). stdin is a standard pipe, not a PTY. " +
  "Set notify_on_exit: true (on exec_command or write_stdin) when starting background work you do not want to poll: " +
  "you can end your turn or work on other things, and <command_notification> will arrive automatically when it finishes " +
  "(unless you already observed its exit with write_stdin). Pass node on exec_command to run on another accessible node; " +
  "follow-up write_stdin calls automatically route to the node bound to that session_id.";

export function terminalExtension(
  port: TerminalPort,
  options: { readonly closing?: AbortSignal } = {},
): Extension {
  const CommandWatchTask = defineTask<WatchInput, WatchState, WatchResult>({
    name: "palace.terminal.watch",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      async wait(task, runtime, context) {
        const signal = combineSignals(options.closing, runtime.signal);
        const raw = await raceAbortError(
          port.wait(
            { sessionId: task.input.sessionId, conversationId: runtime.conversationId },
            signal,
          ),
          signal,
        );
        const decoded = decodeTerminalWaitOutcome(raw);
        let message: string;
        if (!decoded.ok) {
          message =
            `<command_notification session_id="${task.input.sessionId}" status="lost">\n` +
            `Command: ${task.input.command}\n` +
            `${decoded.error}\n` +
            "</command_notification>";
        } else if (decoded.outcome.consumed) {
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: { notified: false } },
            }),
            context,
          );
          return;
        } else {
          const { text, isError } = formatTerminalOutcome(decoded.outcome.outcome);
          message =
            `<command_notification session_id="${task.input.sessionId}" status="${isError ? "failed" : "completed"}">\n` +
            `Command: ${task.input.command}\n` +
            `${text}\n` +
            "</command_notification>";
        }
        const conversation = await runtime.conversation(runtime.conversationId, context);
        if (conversation !== undefined) {
          await conversation.submit(
            {
              type: "input",
              content: message,
              requestId: `command-watch:${runtime.taskId}`,
              whenBusy: "steer",
            },
            context,
          );
        }
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: { notified: conversation !== undefined } },
          }),
          context,
        );
      },
    },
    async abort(_task, runtime, context) {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });

  const execCommandTool = defineTool({
    name: "exec_command",
    description:
      "Execute a shell command on your home node (or a named accessible node). Returns output if it finishes before " +
      "yield_time_ms, or a session_id with running: true if still running. Set notify_on_exit: true to be notified " +
      "automatically when it exits instead of polling.",
    parameters: Type.Object({
      command: Type.String(),
      workdir: Type.Optional(
        Type.String({ description: "Working directory relative to workspace or absolute" }),
      ),
      yield_time_ms: Type.Optional(
        Type.Integer({
          minimum: EXEC_YIELD_MS.min,
          maximum: EXEC_YIELD_MS.max,
          description: `Wait up to this many ms before yielding (default ${EXEC_YIELD_MS.default})`,
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: TERMINAL_TIMEOUT_MS.max,
          description: "Hard wall-clock timeout in ms before killing the process group",
        }),
      ),
      notify_on_exit: Type.Optional(
        Type.Boolean({
          description:
            "If still running after yield_time_ms, wake the conversation when the command exits",
        }),
      ),
      node: Type.Optional(
        Type.String({ description: "Accessible node name; defaults to your home node" }),
      ),
    }),
    replay: "unsafe",
    outputLimits: { retain: "tail" },
    async execute(args, api, context) {
      const sessionId = randomUUID();
      const signal = combineSignals(options.closing, context.abortSignal);
      const raw = await untilAborted(
        port.exec(
          {
            sessionId,
            command: args.command,
            yieldTimeMs: args.yield_time_ms ?? EXEC_YIELD_MS.default,
            conversationId: api.conversationId,
            ...(args.workdir === undefined ? {} : { workdir: args.workdir }),
            ...(args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms }),
            ...(args.node === undefined ? {} : { node: args.node }),
          },
          (chunk) => api.output(chunk),
          signal,
        ),
        signal,
      );
      const decoded = decodeTerminalOutcome(raw);
      if (!decoded.ok) {
        return { content: [{ type: "text", text: decoded.error }], isError: raw.isError };
      }
      const { text, isError } = formatTerminalOutcome(decoded.outcome);
      if (decoded.outcome.running && args.notify_on_exit === true) {
        await api.commit(
          (tx) =>
            tx.createTask(
              CommandWatchTask,
              { sessionId, command: args.command },
              { ownership: { kind: "conversation" }, background: true },
            ),
          context,
        );
        return {
          content: [
            {
              type: "text",
              text: `${text}\n[Exit notification armed: you will receive <command_notification> automatically when this session completes.]`,
            },
          ],
          isError,
        };
      }
      return { content: [{ type: "text", text }], isError };
    },
  });

  const writeStdinTool = defineTool({
    name: "write_stdin",
    description:
      "Interact with a running terminal session: write chars to stdin, close stdin (eof: true), read incremental " +
      "output, terminate (kill: true), or arm notify_on_exit.",
    parameters: Type.Object({
      session_id: Type.String({ minLength: 1 }),
      chars: Type.Optional(Type.String()),
      eof: Type.Optional(Type.Boolean()),
      kill: Type.Optional(Type.Boolean()),
      yield_time_ms: Type.Optional(
        Type.Integer({
          minimum: WRITE_YIELD_MS.min,
          maximum: WRITE_YIELD_MS.max,
          description: `Wait up to this many ms for output or exit (default ${WRITE_YIELD_MS.default})`,
        }),
      ),
      notify_on_exit: Type.Optional(
        Type.Boolean({
          description:
            "If still running after yield_time_ms, wake the conversation when the command exits",
        }),
      ),
    }),
    replay: "unsafe",
    outputLimits: { retain: "tail" },
    async execute(args, api, context) {
      const signal = combineSignals(options.closing, context.abortSignal);
      const raw = await untilAborted(
        port.write(
          {
            sessionId: args.session_id,
            yieldTimeMs: args.yield_time_ms ?? WRITE_YIELD_MS.default,
            conversationId: api.conversationId,
            ...(args.chars === undefined ? {} : { chars: args.chars }),
            ...(args.eof === undefined ? {} : { eof: args.eof }),
            ...(args.kill === undefined ? {} : { kill: args.kill }),
          },
          (chunk) => api.output(chunk),
          signal,
        ),
        signal,
      );
      const decoded = decodeTerminalOutcome(raw);
      if (!decoded.ok) {
        return { content: [{ type: "text", text: decoded.error }], isError: raw.isError };
      }
      const { text, isError } = formatTerminalOutcome(decoded.outcome);
      if (decoded.outcome.running && args.notify_on_exit === true) {
        const created = await api.commit(async (tx) => {
          let cursor: Cursor | undefined;
          do {
            const page = await tx.scanTasks(
              { conversationId: api.conversationId, kind: CommandWatchTask.definition.name },
              100,
              cursor,
            );
            for (const existing of page.items) {
              if (
                existing.state.status !== "terminal" &&
                typeof existing.input === "object" &&
                existing.input !== null &&
                (existing.input as { sessionId?: unknown }).sessionId === args.session_id
              ) {
                return false;
              }
            }
            cursor = page.next;
          } while (cursor !== undefined);
          await tx.createTask(
            CommandWatchTask,
            { sessionId: args.session_id, command: "(terminal session)" },
            { ownership: { kind: "conversation" }, background: true },
          );
          return true;
        }, context);
        const note = created
          ? "[Exit notification armed: you will receive <command_notification> automatically when this session completes.]"
          : "[Exit notification already armed.]";
        return { content: [{ type: "text", text: `${text}\n${note}` }], isError };
      }
      return { content: [{ type: "text", text }], isError };
    },
  });

  return defineExtension({
    name: "terminal",
    sections: [section("terminal", () => TERMINAL_INSTRUCTIONS)],
    tools: [execCommandTool, writeStdinTool],
    tasks: [CommandWatchTask],
  });
}

function combineSignals(
  closing: AbortSignal | undefined,
  call: AbortSignal | undefined,
): AbortSignal {
  const active = [closing, call].filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return new AbortController().signal;
  return active.length === 1 ? active[0]! : AbortSignal.any(active);
}

function untilAborted(result: Promise<ToolResult>, signal: AbortSignal): Promise<ToolResult> {
  if (signal.aborted) return Promise.resolve(STOPPED);
  const abort = Promise.withResolvers<ToolResult>();
  const onAbort = () => abort.resolve(STOPPED);
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([result, abort.promise]).finally(() =>
    signal.removeEventListener("abort", onAbort),
  );
}

async function raceAbortError<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortError = () => (signal.reason instanceof Error ? signal.reason : new Error("aborted"));
  if (signal.aborted) throw abortError();
  const deferred = Promise.withResolvers<never>();
  const onAbort = () => deferred.reject(abortError());
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await Promise.race([work, deferred.promise]);
    if (signal.aborted) throw abortError();
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
