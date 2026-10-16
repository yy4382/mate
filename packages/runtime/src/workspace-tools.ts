import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  type JsonObject,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { bashTool, type BashArguments, type ToolName } from "@mate/node-protocol";
import { z } from "zod";

export type WorkspaceToolName = ToolName;

export type WorkspaceToolRequest = {
  readonly tool: WorkspaceToolName;
  readonly arguments: JsonObject;
};

export type WorkspaceToolResult = {
  readonly content: NonNullable<ToolExecutionResult["content"]>;
  readonly isError: boolean;
  readonly details?: JsonValue;
};

/**
 * Where workspace tools execute. The runtime forwards each whole call; the node runs `bash` itself and the file tools
 * with Durable's own tools on its local filesystem. An offline node or a lost connection comes back as an error result
 * whose text says so. Aborting `signal` stops the call where it runs.
 */
export interface WorkspacePort {
  run(
    request: WorkspaceToolRequest,
    output: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<WorkspaceToolResult>;
}

/**
 * What the model is told about each tool. The file tools run as Durable's own on the node, so their definitions are
 * Durable's; `bash` is the node's own, defined once in the node protocol.
 */
const definitions = [
  {
    name: "bash",
    tool: {
      ...bashTool,
      parameters: Type.Unsafe<BashArguments>(bashTool.parameters),
    },
  },
  { name: "read", tool: createReadTool() },
  { name: "write", tool: createWriteTool() },
  { name: "edit", tool: createEditTool() },
] as const satisfies readonly {
  name: WorkspaceToolName;
  tool: Pick<ToolRegistration, "name" | "description" | "parameters">;
}[];

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
            { tool: name, arguments: toolArguments.parse(args) },
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
