import { realpath } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  encodeMemoryReadOutcome,
  MEMORY_MAX_BYTES,
  type MemoryReadOutcome,
  type ToolResult,
} from "@palace/node-protocol";
import { WorkspaceEnv } from "./files.ts";

const MEMORY_PATH = "memory/MEMORY.md";

/** Read `<workspace>/memory/MEMORY.md` safely within the workspace boundary up to `MEMORY_MAX_BYTES`. */
export async function readWorkspaceMemory(workspace: string): Promise<ToolResult> {
  return encodeMemoryReadOutcome(await readOutcome(workspace));
}

async function readOutcome(workspace: string): Promise<MemoryReadOutcome> {
  try {
    const env = new WorkspaceEnv(await realpath(workspace), workspace);
    const resolved = await env.absolutePath(MEMORY_PATH, BACKGROUND_CONTEXT);
    if (!resolved.ok) {
      return { status: "unreadable", message: `${MEMORY_PATH} is outside the workspace` };
    }
    const file = await env.openBinaryReader(resolved.value, undefined, BACKGROUND_CONTEXT);
    if (!file.ok) {
      if (file.error.code === "not_found" || file.error.code === "not_directory") {
        return { status: "missing" };
      }
      return {
        status: "unreadable",
        message: `${MEMORY_PATH} cannot be read: ${file.error.message}`,
      };
    }
    try {
      const read = await file.value.read(0, MEMORY_MAX_BYTES + 1, BACKGROUND_CONTEXT);
      if (!read.ok) {
        return {
          status: "unreadable",
          message: `${MEMORY_PATH} cannot be read: ${read.error.message}`,
        };
      }
      const truncated = read.value.length > MEMORY_MAX_BYTES;
      const kept = read.value.subarray(0, MEMORY_MAX_BYTES);
      const content = new TextDecoder().decode(kept, { stream: truncated });
      return { status: "ok", content, truncated };
    } finally {
      await file.value.close(BACKGROUND_CONTEXT);
    }
  } catch (error) {
    return {
      status: "unreadable",
      message: `${MEMORY_PATH} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
