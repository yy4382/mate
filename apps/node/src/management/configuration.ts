import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { toWebSocketUrl } from "../connection/node-client.js";
import { nodePaths } from "./paths.js";

const absolutePathSchema = z
  .string()
  .refine(isAbsolute)
  .refine((value) => !/[\r\n\0]/.test(value));
export const nodeConfigurationSchema = z
  .object({
    MATE_CONTROL_PLANE_URL: z.string().min(1),
    MATE_NODE_DATA_DIR: absolutePathSchema.optional(),
    MATE_NODE_AGENT_WORKSPACE_ROOT: absolutePathSchema.optional(),
    MATE_NODE_PAIRING_TOKEN: z.string().min(32).max(256).optional(),
  })
  .strict();

export function readNodeConfiguration(file: string, paths = nodePaths()) {
  if (!isAbsolute(file)) throw new Error("Node configuration path must be absolute");
  const directory = lstatSync(dirname(file));
  const info = lstatSync(file);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0 ||
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      "Node configuration must be an account-owned private directory and regular file (0700/0600)",
    );
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("Node configuration is not valid JSON; contents were omitted");
  }
  const parsed = nodeConfigurationSchema.safeParse(decoded);
  if (!parsed.success)
    throw new Error(
      "Node configuration is not valid; use the documented URL and absolute path fields",
    );
  try {
    toWebSocketUrl(parsed.data.MATE_CONTROL_PLANE_URL);
  } catch {
    throw new Error(
      "Node configuration URL is not valid; credentials, queries and fragments are forbidden",
    );
  }
  const dataDirectory = parsed.data.MATE_NODE_DATA_DIR ?? paths.dataDirectory;
  return {
    controlPlaneUrl: parsed.data.MATE_CONTROL_PLANE_URL,
    dataDirectory,
    agentWorkspaceRoot: parsed.data.MATE_NODE_AGENT_WORKSPACE_ROOT ?? `${dataDirectory}/agents`,
    ...(parsed.data.MATE_NODE_PAIRING_TOKEN
      ? { pairingToken: parsed.data.MATE_NODE_PAIRING_TOKEN }
      : {}),
  };
}
