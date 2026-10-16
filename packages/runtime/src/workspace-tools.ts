import type { JsonValue } from "@earendil-works/chord";
import {
  defineExtension,
  type JsonObject,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { z } from "zod";

export type WorkspaceToolName = "bash" | "read" | "write" | "edit";

export type WorkspaceToolRequest = {
  /** Stable across a crash and its recovery: the Durable tool task ID. */
  readonly requestId: string;
  readonly tool: WorkspaceToolName;
  readonly arguments: JsonObject;
};

export type WorkspaceToolResult = {
  readonly content: NonNullable<ToolExecutionResult["content"]>;
  readonly isError: boolean;
  readonly details?: JsonValue;
};

/**
 * Where workspace tools execute. The runtime forwards each whole call; the node runs it with Durable's own tool on its
 * local filesystem. An offline node or a lost connection comes back as an error result whose text says so.
 */
export interface WorkspacePort {
  run(
    request: WorkspaceToolRequest,
    output: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<WorkspaceToolResult>;
}

const definitions = [
  { name: "bash", tool: createBashTool() },
  { name: "read", tool: createReadTool() },
  { name: "write", tool: createWriteTool() },
  { name: "edit", tool: createEditTool() },
] as const satisfies readonly { name: WorkspaceToolName; tool: ToolRegistration }[];

const toolArguments = z.record(z.string(), z.json());

/** Only reading is safe to repeat after a crash; every other workspace tool reports itself interrupted instead. */
const replaySafe: ReadonlySet<WorkspaceToolName> = new Set(["read"]);

/**
 * Forward each workspace call to the port. When the runtime closes, the call returns at once with a stopped result
 * instead of waiting for the node, so pausing an Agent never waits on a long command.
 */
export function workspaceExtension(port: WorkspacePort, closing: AbortSignal) {
  return defineExtension({
    name: "workspace",
    tools: definitions.map(({ name, tool }): ToolRegistration => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      replay: replaySafe.has(name) ? "safe" : "unsafe",
      async execute(args, api, context) {
        const signal = AbortSignal.any([
          closing,
          ...(context.abortSignal === undefined ? [] : [context.abortSignal]),
        ]);
        const result = await untilAborted(
          port.run(
            { requestId: `tool:${api.taskId}`, tool: name, arguments: toolArguments.parse(args) },
            (chunk) => api.output(chunk),
            signal,
          ),
          signal,
        );
        return result.details === undefined
          ? { content: result.content, isError: result.isError }
          : { content: result.content, isError: result.isError, details: result.details };
      },
    })),
  });
}

const stopped: WorkspaceToolResult = {
  content: [
    {
      type: "text",
      text: "The call was stopped because the Agent was paused or shut down. Its effect is unknown; it was not retried.",
    },
  ],
  isError: true,
};

function untilAborted(
  result: Promise<WorkspaceToolResult>,
  signal: AbortSignal,
): Promise<WorkspaceToolResult> {
  if (signal.aborted) return Promise.resolve(stopped);
  const abort = Promise.withResolvers<WorkspaceToolResult>();
  const onAbort = () => abort.resolve(stopped);
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([result, abort.promise]).finally(() =>
    signal.removeEventListener("abort", onAbort),
  );
}
