import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTask,
  defineTool,
  type Harness,
  type TaskId,
  type TaskRuntime,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { BashArguments } from "@mate/node-protocol";
import { deliverInput } from "./assistants.ts";
import type { WorkspacePort, WorkspaceToolResult } from "./workspace-tools.ts";

type CommandState =
  | { phase: "start" }
  /** The command was handed to the node. Finding the task here means its process stopped before the command ended. */
  | { phase: "interrupted" };

type CommandRuntime = TaskRuntime<BashArguments, CommandState, null, object>;

const reply = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  isError,
});

/**
 * Background commands: `bash` calls with `background: true`. Each runs in a background task of the conversation that
 * started it, so it neither keeps that conversation busy nor ends with its run, and its ID is the command's ID. When
 * the command ends, the task ends in the same commit that hands its result to `deliverInput` for that conversation,
 * with request ID `command:<ID>`, so a restart never reports it twice and an assistant's answer to it reaches the
 * primary conversation. A command interrupted by a close or crash is reported interrupted, never rerun.
 */
export function backgroundCommands(
  node: WorkspacePort,
  closing: AbortSignal,
  abortTask: Harness["abortTask"],
) {
  const BackgroundCommand = defineTask<BashArguments, CommandState, null>({
    name: "mate.background-command",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (command, runtime, context) => {
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "interrupted" } }),
          context,
        );
        const signal = AbortSignal.any([closing, runtime.signal]);
        const result = await node.run(
          { tool: "bash", arguments: command.input },
          () => undefined,
          signal,
        );
        const outcome = result.isError ? "failed" : "finished";
        // Durable refuses this commit after bash_stop or a close, so a stopped command never reports from here: its
        // abort handler ends it, or the reopened runtime finds it interrupted.
        await report(
          command.id,
          `[background command ${command.id} ${outcome}] ${command.input.command}\n${textOf(result)}`,
          runtime,
          context,
        );
      },
      interrupted: (command, runtime, context) =>
        report(
          command.id,
          `[background command ${command.id} interrupted] ${command.input.command}\n` +
            "The Agent was paused or restarted before this command's result was recorded. The command may have been " +
            "stopped midway or may have finished unseen. It was not rerun; how far it got is unknown.",
          runtime,
          context,
        ),
    },
    abort: (_command, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });

  /** Start `call` as a background command of the calling conversation and say how its result will arrive. */
  async function start(call: BashArguments, api: ToolExecutionApi, context: Context) {
    const id = await api.createTask(
      BackgroundCommand,
      call,
      { ownership: { kind: "conversation" }, background: true },
      context,
    );
    return reply(
      `Started background command ${id}. Its result arrives as a new input when it ends; to stop it, call ` +
        `bash_stop with id ${id}.`,
    );
  }

  const stop = defineTool({
    name: "bash_stop",
    description:
      "Stop a background command you started, by the ID bash returned. Every process the command started is killed, " +
      "as on a timeout. A command that has already ended has nothing to stop; its result reaches you as an input.",
    parameters: Type.Object({
      id: Type.Integer({ minimum: 1, description: "The command ID bash returned" }),
    }),
    // Stopping twice changes nothing, and the answer is read from how the command ended.
    replay: "safe",
    async execute({ id }, api, context) {
      // Any integer the model sends; it names one of this conversation's commands only if the record says so.
      const taskId = id as TaskId;
      const record = await api.getTask(taskId, context);
      if (
        record?.kind !== BackgroundCommand.definition.name ||
        record.conversationId !== api.conversationId
      )
        return reply(`You have no background command ${id}.`, true);
      await abortTask(taskId, context);
      const { outcome } = (await api.waitForTask(taskId, context)).state;
      return reply(
        outcome.status === "aborted"
          ? `Stopped background command ${id}.`
          : `Background command ${id} had already ended; its result reaches you as an input.`,
      );
    },
  });

  return { start, stop, task: BackgroundCommand };
}

/** End the command and hand its report to its conversation, in one commit. */
function report(
  id: TaskId,
  content: string,
  runtime: CommandRuntime,
  context: Context,
): Promise<void> {
  return runtime.commit(async (tx) => {
    await deliverInput(tx, {
      conversationId: runtime.conversationId,
      content,
      whenBusy: "steer",
      requestId: `command:${id}`,
    });
    return { status: "terminal", outcome: { status: "completed", result: null } };
  }, context);
}

function textOf(result: WorkspaceToolResult): string {
  return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}
