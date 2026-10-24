import { realpath } from "node:fs/promises";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type {
  ToolDiagnostic,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { err, FileError, ok, type Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { ToolResult } from "@mate/node-protocol";
import type { TSchema } from "typebox";
import { currentPlatform } from "./platforms/index.ts";

export type FileToolName = "read" | "write" | "edit";

type Run = (
  args: Record<string, JsonValue>,
  env: WorkspaceEnv,
  context: Context,
) => Promise<ToolResult>;

const read = createReadTool();
const write = createWriteTool();
const edit = createEditTool();
const fileTools: Record<FileToolName, Run> = {
  read: (args, env, context) => execute(read, args, env, context),
  write: (args, env, context) => execute(write, args, env, context),
  edit: (args, env, context) => execute(edit, args, env, context),
};

/**
 * Run Durable's own file tool on the Agent's workspace, as a Harness would run it locally: arguments repaired and
 * validated the same way, a thrown error turned into an error result, and diagnostics rendered after the content.
 */
export async function runFileTool(
  name: FileToolName,
  args: Record<string, JsonValue>,
  workspace: string,
  signal: AbortSignal,
): Promise<ToolResult> {
  try {
    const env = new WorkspaceEnv(await realpath(workspace), workspace);
    return await fileTools[name](args, env, withAbortSignal(signal, BACKGROUND_CONTEXT));
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true);
  }
}

async function execute<P extends TSchema, D extends JsonValue>(
  tool: ToolRegistration<P, D>,
  raw: Record<string, JsonValue>,
  env: WorkspaceEnv,
  context: Context,
): Promise<ToolResult> {
  const prepared = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
  const args = validateToolArguments(tool, {
    type: "toolCall",
    id: "node",
    name: tool.name,
    arguments: prepared,
  });
  const reported = { output: "", diagnostics: [] as ToolDiagnostic[] };
  const result = await tool.execute(args, localApi<D>(env, reported), context);
  return render(result, reported);
}

function render(
  result: ToolExecutionResult,
  reported: { output: string; diagnostics: ToolDiagnostic[] },
): ToolResult {
  const parts = result.content?.map((part) =>
    part.type === "text" ? part.text : `[${part.mimeType} image omitted: the node returns text]`,
  ) ?? [reported.output];
  const remarks = [...reported.diagnostics, ...(result.diagnostics ?? [])].map(
    (d) => `[${d.severity}] ${d.message}`,
  );
  return text([...parts, ...remarks].filter((part) => part !== "").join("\n"), result.isError);
}

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: value === "" ? "(no output)" : value }], isError };
}

/**
 * The part of a tool invocation the file tools use: the environment, output, and diagnostics. The rest belongs to a
 * Durable Harness (tasks, documents, models), which the node does not have; Durable's file tools never call it.
 */
function localApi<D extends JsonValue>(
  env: WorkspaceEnv,
  reported: { output: string; diagnostics: ToolDiagnostic[] },
): ToolExecutionApi<D> {
  const absent = (): never => {
    throw new Error("A node runs only workspace tools; this needs a Durable Harness");
  };
  return {
    env,
    outputWindow: undefined,
    output: (chunk) => {
      reported.output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    },
    diagnostic: (diagnostic) => reported.diagnostics.push(diagnostic),
    details: async () => {},
    get taskId(): never {
      return absent();
    },
    get conversationId(): never {
      return absent();
    },
    get callId(): never {
      return absent();
    },
    get registry(): never {
      return absent();
    },
    get models(): never {
      return absent();
    },
    agent: absent,
    commit: absent,
    memo: absent,
    createTask: absent,
    getTask: absent,
    waitForTask: absent,
    conversation: absent,
    snapshot: absent,
    snapshotAsOf: absent,
    watchDoc: absent,
  };
}

/**
 * Durable's local environment, confined to one workspace. Every file tool turns the path it was given into an
 * absolute one through `absolutePath` first, so refusing there keeps `..`, absolute paths elsewhere, and symbolic
 * links that point outward from reaching any file operation.
 */
export class WorkspaceEnv extends NodeExecutionEnv {
  readonly #root: string;
  readonly #configuredRoot: string;

  constructor(root: string, configuredRoot: string) {
    super({ cwd: root });
    this.#root = root;
    this.#configuredRoot = configuredRoot;
  }

  override async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
    const resolved = await super.absolutePath(path, context);
    if (!resolved.ok) return resolved;
    const accepted = await currentPlatform().workspacePaths.resolve(
      this.#root,
      this.#configuredRoot,
      path,
      resolved.value,
    );
    return accepted !== undefined
      ? ok(accepted)
      : err(new FileError("permission_denied", `${path} is outside the workspace`, path));
  }
}
