import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "@mate/clock";
import {
  parseBashArguments,
  type GatewayBrowse,
  type GatewayRunTool,
  type NodeBrowseOutcome,
  type ToolResult,
} from "@mate/node-protocol";
import { browseWorkspace } from "./browse.ts";
import { Commands } from "./commands.ts";
import { runFileTool } from "./files.ts";

/** Executes tools and retains command handles for stopping and shutdown. */
export class Executor {
  readonly #root: string;
  readonly #commands: Commands;

  constructor(workspacesRoot: string, clock: Clock) {
    this.#root = workspacesRoot;
    this.#commands = new Commands(clock);
  }

  /** Run one tool call to its end. `signal` stops it: the Agent was stopped or nobody waits for the result any more. */
  async run(
    call: GatewayRunTool,
    onOutput: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const prepared = this.prepareWorkspace(call.agentId);
    if (prepared.isError) return prepared;
    const directory = join(this.#root, call.agentId);
    if (call.tool !== "bash") return runFileTool(call.tool, call.arguments, directory, signal);
    const args = parseBashArguments(call.arguments);
    if (!args.ok) return failure(args.error);
    const env = { ...process.env, PWD: directory, HOME: directory };
    return this.#commands.run(
      {
        command: args.arguments.command,
        directory,
        env,
        timeoutSeconds: args.arguments.timeout,
      },
      onOutput,
      signal,
    );
  }

  /** Read a path in the Agent's workspace for an admin, changing nothing. */
  async browse(call: GatewayBrowse): Promise<NodeBrowseOutcome> {
    const workspace = join(this.#root, call.agentId);
    if (!isDirectory(workspace)) {
      return {
        ok: false,
        reason: "not-found",
        message: `The workspace ${workspace} does not exist.`,
      };
    }
    return browseWorkspace(workspace, call.path);
  }

  /** Create the Agent's workspace with an empty MEMORY.md; repeating it changes nothing. */
  prepareWorkspace(agentId: string): ToolResult {
    const workspace = join(this.#root, agentId);
    try {
      const created = mkdirSync(workspace, { recursive: true });
      if (created !== undefined) writeFileSync(join(workspace, "MEMORY.md"), "", { flag: "wx" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return failure(`Failed to prepare workspace: ${reason}`);
    }
    return { content: [{ type: "text", text: "Workspace prepared." }], isError: false };
  }

  /** Kill every process group the node started. */
  shutdown(): void {
    this.#commands.killAll();
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
