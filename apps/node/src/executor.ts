import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "@mate/clock";
import {
  parseBashArguments,
  type GatewayBrowse,
  type GatewayRunTool,
  type NodeBrowseOutcome,
  type NodeAccess,
  type ToolResult,
} from "@mate/node-protocol";
import { browseWorkspace } from "./browse.ts";
import { Commands } from "./commands.ts";
import { runFileTool } from "./files.ts";
import { Shells } from "./shells.ts";

/** Executes tools and retains command handles for stopping and shutdown. */
export class Executor {
  readonly #root: string;
  readonly #commands: Commands;
  readonly #shells: Shells;

  constructor(workspacesRoot: string, clock: Clock) {
    this.#root = workspacesRoot;
    this.#commands = new Commands(clock);
    this.#shells = new Shells(this.#commands);
  }

  /** Run one tool call to its end. `signal` stops it: the Agent was stopped or nobody waits for the result any more. */
  async run(
    call: GatewayRunTool,
    onOutput: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const directory = join(this.#root, call.agentId);
    if (call.access === "visit") {
      const prepared = this.prepareWorkspace(call.agentId, "visit");
      if (prepared.isError) return prepared;
    } else if (!isDirectory(directory)) {
      return failure(
        `The workspace ${directory} does not exist. The node does not recreate it; prepare the workspace again.`,
      );
    }
    if (call.tool !== "bash") return runFileTool(call.tool, call.arguments, directory, signal);
    const args = parseBashArguments(call.arguments);
    if (!args.ok) return failure(args.error);
    if (process.platform !== "win32")
      return this.#shells.run(
        {
          agentId: call.agentId,
          workspace: directory,
          role: call.conversationRole,
          arguments: args.arguments,
        },
        onOutput,
        signal,
      );
    if (args.arguments.workdir !== undefined)
      return failure("The workdir argument is unavailable on Windows nodes.");
    const env = { ...process.env, PWD: directory, HOME: directory };
    const outcome = await this.#commands.run(
      {
        command: args.arguments.command,
        directory,
        env,
        timeoutSeconds: args.arguments.timeout,
      },
      onOutput,
      signal,
    );
    return outcome.result;
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

  /** Prepare a workspace, initializing MEMORY.md only for home access. Existing files are preserved. */
  prepareWorkspace(agentId: string, access: NodeAccess = "home"): ToolResult {
    const workspace = join(this.#root, agentId);
    try {
      mkdirSync(workspace, { recursive: true });
      if (access === "home") {
        const memory = join(workspace, "MEMORY.md");
        if (!existsSync(memory)) writeFileSync(memory, "", { flag: "wx" });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return failure(`Failed to prepare workspace: ${reason}`);
    }
    return { content: [{ type: "text", text: "Workspace prepared." }], isError: false };
  }

  /** Kill every process group the node started. */
  shutdown(): void {
    this.#shells.shutdown();
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
