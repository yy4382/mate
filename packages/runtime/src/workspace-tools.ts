import type { Context, JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  type Harness,
  type JsonObject,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { bashTool, parseBashArguments, type ToolName } from "@mate/node-protocol";
import { z } from "zod";
import { backgroundCommands } from "./background-commands.ts";

export type WorkspaceToolName = ToolName;

export type WorkspaceToolRequest = {
  readonly tool: WorkspaceToolName;
  readonly arguments: JsonObject;
  readonly node?: string;
};

export type WorkspaceNode = {
  readonly name: string;
  readonly online: boolean;
  readonly platform: string | null;
  readonly home: boolean;
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
  nodes(): Promise<WorkspaceNode[]>;
}

/** The file tools run as Durable's own on the node, so the model is told Durable's definitions of them. */
const fileTools = [
  { name: "read", tool: createReadTool() },
  { name: "write", tool: createWriteTool() },
  { name: "edit", tool: createEditTool() },
] as const satisfies readonly {
  name: Exclude<WorkspaceToolName, "bash">;
  tool: Pick<ToolRegistration, "name" | "description" | "parameters">;
}[];

const toolArguments = z.object({ node: z.string().optional() }).catchall(z.json());

function withNode(parameters: { readonly properties?: object }): ToolRegistration["parameters"] {
  return Type.Unsafe({
    ...parameters,
    properties: {
      ...parameters.properties,
      node: {
        type: "string",
        description:
          "要在哪个 node 上执行，用 `node_list` 查名字。不给就在你的主 node 上执行。每个已授权的 node 都有你自己的工作区，命令和文件路径都从该工作区开始。各 node 的文件独立，不会同步；恢复时读取主 node 的 `MEMORY.md`。",
      },
    },
  });
}

function splitArguments(value: unknown): Omit<WorkspaceToolRequest, "tool"> {
  const { node, ...args } = toolArguments.parse(value);
  return { arguments: args, ...(node === undefined ? {} : { node }) };
}

/**
 * Forward each workspace call to the port. When the runtime closes, the call returns at once with a stopped result
 * instead of waiting for the node, so pausing an Agent never waits on a long command.
 */
export function workspaceExtension(
  port: WorkspacePort,
  closing: AbortSignal,
  abortTask: Harness["abortTask"],
) {
  const node: WorkspacePort = {
    run: (request, output, signal) => untilAborted(port.run(request, output, signal), signal),
    nodes: () => port.nodes(),
  };
  const commands = backgroundCommands(node, closing, abortTask);

  async function forward(
    request: WorkspaceToolRequest,
    api: ToolExecutionApi,
    context: Context,
  ): Promise<ToolExecutionResult> {
    const signal = AbortSignal.any([
      closing,
      ...(context.abortSignal === undefined ? [] : [context.abortSignal]),
    ]);
    const result = await node.run(request, (chunk) => api.output(chunk), signal);
    return result.details === undefined
      ? { content: result.content, isError: result.isError }
      : { content: result.content, isError: result.isError, details: result.details };
  }

  /**
   * `bash` is the node's own, defined once in the node protocol. Its arguments are parsed with the protocol's schema
   * here as well as on the node, so a bad timeout is refused before anything is sent and the node receives the call
   * with its mode's default timeout applied.
   */
  const bash: ToolRegistration = {
    ...bashTool,
    parameters: withNode(bashTool.parameters),
    replay: "unsafe",
    async execute(args, api, context) {
      const { arguments: argsWithoutNode, ...target } = splitArguments(args);
      const call = parseBashArguments(argsWithoutNode);
      if (!call.ok) return { content: [{ type: "text", text: call.error }], isError: true };
      if (call.arguments.background)
        return commands.start({ ...call.arguments, ...target }, api, context);
      return forward({ tool: "bash", arguments: call.arguments, ...target }, api, context);
    },
  };

  return defineExtension({
    name: "workspace",
    tools: [
      bash,
      commands.stop,
      {
        name: "node_list",
        description: "列出你现在能访问的 node，包含名字、在线状态、平台，以及哪个是你的主 node。",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async () => ({
          content: [{ type: "text", text: JSON.stringify(await node.nodes()) }],
          isError: false,
        }),
      },
      ...fileTools.map(({ name, tool }): ToolRegistration => ({
        name: tool.name,
        description: tool.description,
        parameters: withNode(tool.parameters),
        // Only reading is safe to repeat after a crash; writing and editing report themselves interrupted instead.
        replay: name === "read" ? "safe" : "unsafe",
        execute: (args, api, context) =>
          forward({ tool: name, ...splitArguments(args) }, api, context),
      })),
    ],
    tasks: [commands.task],
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
