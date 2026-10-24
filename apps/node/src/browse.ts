import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { BinaryReader, FileError } from "@earendil-works/pi-durable/env";
import {
  BROWSE_DIRECTORY_ENTRIES,
  BROWSE_FILE_BYTES,
  type NodeBrowseOutcome,
} from "@mate/node-protocol";
import { WorkspaceEnv } from "./files.ts";

const context = BACKGROUND_CONTEXT;

/**
 * Read `path` in the workspace without changing anything. The path is resolved by the same workspace environment the
 * file tools use, so what they may not reach, browsing may not either.
 */
export async function browseWorkspace(workspace: string, path: string): Promise<NodeBrowseOutcome> {
  try {
    const env = new WorkspaceEnv(await realpath(workspace), workspace);
    const resolved = await env.absolutePath(path, context);
    if (!resolved.ok) return refuse("outside-workspace", `${path} is outside the workspace`);
    const at = relative(env.cwd, resolved.value) || ".";
    // Opening is non-blocking, so a FIFO is refused here instead of waiting for a writer.
    const file = await env.openBinaryReader(resolved.value, undefined, context);
    if (file.ok) {
      try {
        return await readStart(file.value, at);
      } finally {
        await file.value.close(context);
      }
    }
    if (file.error.code !== "is_directory") return refusal(file.error, path);
    return await listDirectory(env, resolved.value, at);
  } catch (error) {
    return refuse("unreadable", `${path} cannot be read: ${String(error)}`);
  }
}

async function readStart(file: BinaryReader, at: string): Promise<NodeBrowseOutcome> {
  const info = await file.info(context);
  if (!info.ok) return refusal(info.error, at);
  const read = await file.read(0, BROWSE_FILE_BYTES + 1, context);
  if (!read.ok) return refusal(read.error, at);
  const truncated = read.value.length > BROWSE_FILE_BYTES;
  const kept = read.value.subarray(0, BROWSE_FILE_BYTES);
  const { size } = info.value;
  if (kept.includes(0)) return { ok: true, listing: { kind: "binary", path: at, size } };
  // Streaming holds back a character cut off at the limit instead of decoding it as U+FFFD.
  const content = new TextDecoder().decode(kept, { stream: truncated });
  return { ok: true, listing: { kind: "file", path: at, size, content, truncated } };
}

async function listDirectory(
  env: WorkspaceEnv,
  directory: string,
  at: string,
): Promise<NodeBrowseOutcome> {
  const reader = await env.openDirReader(directory, context);
  if (!reader.ok) return refusal(reader.error, at);
  try {
    // A page stops short of the size asked for only at the end, so one entry past the limit says there are more.
    const page = await reader.value.next(BROWSE_DIRECTORY_ENTRIES + 1, context);
    if (!page.ok) return refusal(page.error, at);
    const entries = page.value.entries
      .slice(0, BROWSE_DIRECTORY_ENTRIES)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(({ name, kind, size }) => (kind === "file" ? { name, kind, size } : { name, kind }));
    const truncated = page.value.entries.length > BROWSE_DIRECTORY_ENTRIES;
    return { ok: true, listing: { kind: "directory", path: at, entries, truncated } };
  } finally {
    await reader.value.close(context);
  }
}

function refusal(error: FileError, path: string): NodeBrowseOutcome {
  return error.code === "not_found" || error.code === "not_directory"
    ? refuse("not-found", `${path} does not exist`)
    : refuse("unreadable", `${path} cannot be read: ${error.message}`);
}

function refuse(
  reason: Extract<NodeBrowseOutcome, { ok: false }>["reason"],
  message: string,
): NodeBrowseOutcome {
  return { ok: false, reason, message };
}
