import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Clock } from "@mate/clock";
import type { GatewayRunTool, ToolResult } from "@mate/node-protocol";
import { Commands } from "./commands.ts";
import { runFileTool } from "./files.ts";

const bashArguments = z.object({ command: z.string(), timeout: z.number().positive().optional() });

/**
 * Everything the node executes, in the Agents' workspaces under one root. A command runs in a process group the
 * executor remembers until it has finished; `shutdown` ends every such group, including the background of commands
 * that already returned.
 */
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
    const args = bashArguments.safeParse(call.arguments);
    if (!args.success) return failure(`Invalid bash arguments: ${z.prettifyError(args.error)}`);
    return this.#commands.run(
      {
        agentId: call.agentId,
        command: args.data.command,
        workspace,
        timeoutSeconds: args.data.timeout,
      },
      onOutput,
      signal,
    );
  }

  /** Create the Agent's workspace with an empty MEMORY.md; repeating it changes nothing. */
  prepareWorkspace(agentId: string): void {
    const workspace = join(this.#root, agentId);
    mkdirSync(workspace, { recursive: true });
    const memory = join(workspace, "MEMORY.md");
    if (!existsSync(memory)) writeFileSync(memory, "", { flag: "wx" });
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
