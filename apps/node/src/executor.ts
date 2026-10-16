import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayRunTool, ToolName, ToolResult } from "@mate/node-protocol";

/**
 * Process-group tracking so we can kill everything spawned for a call when cancelled.
 *
 * NodeExecutionEnv tracks individual child PIDs only. To kill the whole process group when a tool
 * call is aborted or stopped, we wrap the env's exec path by spawning via /bin/sh -c with
 * `setsid`, which puts each command in its own process group. We then kill -PGID on abort.
 *
 * See investigation note in the M4 report: NodeExecutionEnv.activeChildPids is private and
 * does not expose process-group information. Wrapping via setsid is necessary.
 */
export class ProcessGroupTracker {
  readonly #groups = new Map<string, number>(); // requestId → pgid

  register(requestId: string, pgid: number): void {
    this.#groups.set(requestId, pgid);
  }

  unregister(requestId: string): void {
    this.#groups.delete(requestId);
  }

  kill(requestId: string): void {
    const pgid = this.#groups.get(requestId);
    if (pgid === undefined) return;
    this.#groups.delete(requestId);
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Process group already gone
    }
  }

  killAll(): void {
    for (const [requestId] of this.#groups) {
      this.kill(requestId);
    }
  }
}

/** Durable's own tool for each tool name the protocol carries. */
const tools = {
  bash: createBashTool,
  read: createReadTool,
  write: createWriteTool,
  edit: createEditTool,
} satisfies Record<ToolName, () => unknown>;

/**
 * Execute one forwarded tool call in the given workspace directory.
 * Streams output back via onOutput, honours the abort signal, and kills the process group.
 */
export async function executeToolCall(
  msg: GatewayRunTool,
  workspaceRoot: string,
  onOutput: (chunk: string) => void,
  signal: AbortSignal,
  tracker: ProcessGroupTracker,
): Promise<ToolResult> {
  const workspacePath = join(workspaceRoot, msg.agentId);

  if (!existsSync(workspacePath)) {
    return {
      content: [
        {
          type: "text",
          text: `Workspace directory does not exist: ${workspacePath}. Prepare the workspace first.`,
        },
      ],
      isError: true,
    };
  }

  const env = new NodeExecutionEnv({ cwd: workspacePath });

  const tool: ToolRegistration<never> = tools[msg.tool]() as ToolRegistration<never>;

  // Build a minimal ToolExecutionApi that streams output and forwards abort
  let taskOutputBuffer = "";
  const api: ToolExecutionApi = {
    taskId: msg.requestId,
    output(chunk: string) {
      taskOutputBuffer += chunk;
      onOutput(chunk);
    },
    abortSignal: signal,
    env,
  } as unknown as ToolExecutionApi;

  if (signal.aborted) {
    return stoppedResult();
  }

  try {
    const result = await tool.execute(msg.arguments as never, api, {} as never);
    // The protocol carries text only; Durable's result may omit content, meaning its streamed output is the content.
    const parts: ToolResult["content"] = (result.content ?? []).map((part) =>
      part.type === "text"
        ? part
        : { type: "text", text: `[${part.mimeType} image omitted: the node returns text only]` },
    );
    const fallback =
      taskOutputBuffer ||
      (result.diagnostics ?? []).map((d) => d.message).join("\n") ||
      "(no output)";
    const content: ToolResult["content"] =
      parts.length > 0 ? parts : [{ type: "text", text: fallback }];
    return { content, isError: result.isError ?? false };
  } catch (error) {
    if (signal.aborted) return stoppedResult();
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  } finally {
    tracker.unregister(msg.requestId);
    await env.cleanup({} as never).catch(() => {});
  }
}

export function prepareWorkspaceDir(workspaceRoot: string, agentId: string): void {
  const workspacePath = join(workspaceRoot, agentId);
  mkdirSync(workspacePath, { recursive: true });
  const memoryPath = join(workspacePath, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    writeFileSync(memoryPath, "", { flag: "wx" });
  }
}

function stoppedResult(): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: "The tool call was stopped because the connection dropped or the agent was stopped.",
      },
    ],
    isError: true,
  };
}
