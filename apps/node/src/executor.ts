import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
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

/** Executes tools in Agent workspaces and retains command handles for stopping and shutdown. */
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
    const workspace = join(this.#root, call.agentId);
    // The only check before executing (ARCHITECTURE 4.5 rule 4). The node never recreates a missing workspace: its
    // path is the Agent's, made only by preparing it.
    if (!isDirectory(workspace)) {
      return failure(
        `The workspace ${workspace} does not exist. The node does not recreate it; prepare the workspace again.`,
      );
    }
    if (call.tool !== "bash") return runFileTool(call.tool, call.arguments, workspace, signal);
    const args = parseBashArguments(call.arguments);
    if (!args.ok) return failure(args.error);
    return this.#commands.run(
      {
        agentId: call.agentId,
        command: args.arguments.command,
        workspace,
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
      mkdirSync(workspace, { recursive: true });
      const memory = join(workspace, "MEMORY.md");
      if (!existsSync(memory)) writeFileSync(memory, "", { flag: "wx" });
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
