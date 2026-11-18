import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  section,
  type Extension,
  type JsonObject,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { ToolResult } from "@palace/node-protocol";
import { z } from "zod";
import type { Context } from "@earendil-works/chord";

export type AccessibleNode = {
  readonly name: string;
  readonly online: boolean;
  readonly platform: string | null;
  readonly home: boolean;
};

export type FilesPort = {
  run(
    call: {
      readonly tool: "read" | "write" | "edit";
      readonly arguments: JsonObject;
      readonly node?: string;
      readonly conversationId: number;
    },
    signal: AbortSignal,
  ): Promise<ToolResult>;
  nodes(): Promise<readonly AccessibleNode[]>;
};

const WORKSPACE_FACTS =
  "Every node you may use gives you a workspace of your own, and file tool paths stay rooted inside that workspace. " +
  "Files are separate on each node and never synced. Call node_list to see which nodes you can reach.";

const STOPPED: ToolResult = {
  content: [
    {
      type: "text",
      text: "The call was stopped because the Agent was paused or shut down. Its effect is unknown; it was not retried.",
    },
  ],
  isError: true,
};

const toolArguments = z.object({ node: z.string().optional() }).catchall(z.json());

function withNode(parameters: { readonly properties?: object }): ToolRegistration["parameters"] {
  return Type.Unsafe({
    ...parameters,
    properties: {
      ...parameters.properties,
      node: {
        type: "string",
        description: "Node name to run on (see node_list); defaults to your home node.",
      },
    },
  });
}

function splitArguments(value: unknown): {
  readonly arguments: JsonObject;
  readonly node?: string;
} {
  const { node, ...args } = toolArguments.parse(value);
  return { arguments: args, ...(node === undefined ? {} : { node }) };
}

export function filesExtension(
  port: FilesPort,
  options: { readonly closing?: AbortSignal } = {},
): Extension {
  const fileTools = [
    { name: "read" as const, tool: createReadTool() },
    { name: "write" as const, tool: createWriteTool() },
    { name: "edit" as const, tool: createEditTool() },
  ];

  async function forward(
    name: "read" | "write" | "edit",
    rawArgs: unknown,
    api: ToolExecutionApi,
    context: Context,
  ): Promise<ToolExecutionResult> {
    const active = [options.closing, context.abortSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const signal =
      active.length === 0
        ? new AbortController().signal
        : active.length === 1
          ? active[0]!
          : AbortSignal.any(active);
    const { arguments: args, node } = splitArguments(rawArgs);
    return untilAborted(
      port.run(
        {
          tool: name,
          arguments: args,
          conversationId: api.conversationId,
          ...(node === undefined ? {} : { node }),
        },
        signal,
      ),
      signal,
    );
  }

  return defineExtension({
    name: "files",
    sections: [section("workspace", () => WORKSPACE_FACTS)],
    tools: [
      {
        name: "node_list",
        description: "List nodes you can access, their online status, platform, and home node.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: async () => ({
          content: [{ type: "text", text: JSON.stringify(await port.nodes()) }],
          isError: false,
        }),
      },
      ...fileTools.map(({ name, tool }): ToolRegistration => ({
        name: tool.name,
        description: tool.description,
        parameters: withNode(tool.parameters),
        replay: name === "read" ? "safe" : "unsafe",
        execute: (args, api, context) => forward(name, args, api, context),
      })),
    ],
  });
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
