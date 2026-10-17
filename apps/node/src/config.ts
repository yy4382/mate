import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

/** `~/.config/mate/node.json`: where the node connects, how it pairs the first time, and where workspaces live. */
const nodeConfigSchema = z.strictObject({
  controlPlaneUrl: z.url({ protocol: /^(https?|wss?)$/ }),
  workspacesRoot: z.string().refine(isAbsolute, "must be an absolute path"),
  pairingToken: z.string().min(1).optional(),
});
export type NodeConfig = z.infer<typeof nodeConfigSchema>;

/** The config at `path`, or undefined when there is none; throws when the file exists but is not a valid config. */
export function readConfig(path: string): NodeConfig | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = nodeConfigSchema.safeParse(safeJson(text));
  if (!parsed.success)
    throw new Error(`${path} is not a valid node config: ${parsed.error.message}`);
  return parsed.data;
}

/** Validate `input` and replace the whole file with it, private to this account. */
export function writeConfig(path: string, input: unknown): NodeConfig {
  const config = nodeConfigSchema.parse(input);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.node-${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  return config;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
