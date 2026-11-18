import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "@palace/clock";
import {
  parseTerminalExecArgs,
  parseTerminalWaitArgs,
  parseTerminalWriteArgs,
  type GatewayBrowse,
  type GatewayRunTool,
  type NodeAccess,
  type NodeBrowseOutcome,
  type ToolResult,
} from "@palace/node-protocol";
import { browseWorkspace } from "./browse.ts";
import { Commands } from "./commands.ts";
import { runFileTool } from "./files.ts";
import { readWorkspaceMemory } from "./memory.ts";
import { Shells } from "./shells.ts";
import { TerminalSessions } from "./terminal-sessions.ts";

/** Executes tools and retains command handles for stopping, session multiplexing, and shutdown. */
export class Executor {
  readonly #root: string;
  readonly #commands: Commands;
  readonly #sessions: TerminalSessions;

  constructor(workspacesRoot: string, dataDirectory: string, clock: Clock) {
    this.#root = workspacesRoot;
    this.#commands = new Commands(clock);
    const shells = new Shells(this.#commands, dataDirectory);
    this.#sessions = new TerminalSessions(this.#commands, shells, clock);
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

    switch (call.tool) {
      case "terminal_exec": {
        const parsed = parseTerminalExecArgs(call.arguments);
        if (!parsed.ok) return failure(parsed.error);
        return this.#sessions.exec(
          {
            agentId: call.agentId,
            conversationId: call.conversationId,
            workspace: directory,
            arguments: parsed.arguments,
          },
          onOutput,
          signal,
        );
      }
      case "terminal_write": {
        const parsed = parseTerminalWriteArgs(call.arguments);
        if (!parsed.ok) return failure(parsed.error);
        return this.#sessions.write(
          { agentId: call.agentId, arguments: parsed.arguments },
          onOutput,
          signal,
        );
      }
      case "terminal_wait": {
        const parsed = parseTerminalWaitArgs(call.arguments);
        if (!parsed.ok) return failure(parsed.error);
        return this.#sessions.wait({ agentId: call.agentId, arguments: parsed.arguments }, signal);
      }
      case "memory_read":
        return readWorkspaceMemory(directory);
      case "read":
      case "write":
      case "edit":
        return runFileTool(call.tool, call.arguments, directory, signal);
    }
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

  /** Prepare a workspace, initializing `memory/` only for home access. Existing files are preserved. */
  prepareWorkspace(agentId: string, access: NodeAccess = "home"): ToolResult {
    const workspace = join(this.#root, agentId);
    try {
      mkdirSync(workspace, { recursive: true });
      if (access === "home") {
        mkdirSync(join(workspace, "memory"), { recursive: true });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return failure(`Failed to prepare workspace: ${reason}`);
    }
    return { content: [{ type: "text", text: "Workspace prepared." }], isError: false };
  }

  /** Clean up active terminal sessions when a WebSocket connection closes. */
  connectionClosed(): void {
    this.#sessions.connectionClosed();
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
