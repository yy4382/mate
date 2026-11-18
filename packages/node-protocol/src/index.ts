import { z } from "zod";

// ── Shared primitives ────────────────────────────────────────────────────────

const requestId = z.string().min(1).max(128);
const nodeId = z.string().uuid();
/** Also the name of the Agent's workspace directory on the node, so it can never be `..` or contain a separator. */
const agentId = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/** A JSON value, as tool arguments carry them. */
export type JsonValue = z.infer<ReturnType<typeof z.json>>;

// ── Tool calls ───────────────────────────────────────────────────────────────

/**
 * The workspace tools a node runs. `read`, `write` and `edit` are Durable's own file tools executed on the node's
 * filesystem; `terminal_*` and `memory_read` are the node's own primitives.
 */
export const ToolNameSchema = z.enum([
  "terminal_exec",
  "terminal_write",
  "terminal_wait",
  "read",
  "write",
  "edit",
  "memory_read",
]);
export type ToolName = z.infer<typeof ToolNameSchema>;

/** Tools supported by pre-capability-handshake nodes, assumed when `tools` is absent on connect. */
export const LEGACY_NODE_TOOLS: readonly ToolName[] = ["read", "write", "edit"];

export const NodeAccessSchema = z.enum(["home", "visit"]);
export type NodeAccess = z.infer<typeof NodeAccessSchema>;

// ── Terminal & memory primitives ──────────────────────────────────────────────

/** Bytes of unread terminal output kept per drain: the tail. Earlier unread output is dropped and counted. */
export const TERMINAL_KEPT_OUTPUT_BYTES = 50 * 1024;

export const EXEC_YIELD_MS = { default: 10_000, min: 0, max: 120_000 } as const;
export const WRITE_YIELD_MS = { default: 5_000, min: 0, max: 120_000 } as const;
export const TERMINAL_TIMEOUT_MS = { max: 24 * 60 * 60 * 1000 } as const;
export const MEMORY_MAX_BYTES = 64 * 1024;

export const TerminalExecArgsSchema = z.object({
  sessionId: z.string().min(1).max(128),
  command: z.string(),
  workdir: z.string().min(1).max(4096).optional(),
  yieldTimeMs: z
    .number()
    .int()
    .min(EXEC_YIELD_MS.min)
    .max(EXEC_YIELD_MS.max)
    .default(EXEC_YIELD_MS.default),
  timeoutMs: z.number().int().positive().max(TERMINAL_TIMEOUT_MS.max).optional(),
});
export type TerminalExecArgs = z.output<typeof TerminalExecArgsSchema>;

export function parseTerminalExecArgs(
  value: unknown,
): { ok: true; arguments: TerminalExecArgs } | { ok: false; error: string } {
  const parsed = TerminalExecArgsSchema.safeParse(value);
  return parsed.success
    ? { ok: true, arguments: parsed.data }
    : { ok: false, error: `Invalid terminal_exec arguments: ${z.prettifyError(parsed.error)}` };
}

export const TerminalWriteArgsSchema = z.object({
  sessionId: z.string().min(1).max(128),
  chars: z.string().optional(),
  eof: z.boolean().optional(),
  kill: z.boolean().optional(),
  yieldTimeMs: z
    .number()
    .int()
    .min(WRITE_YIELD_MS.min)
    .max(WRITE_YIELD_MS.max)
    .default(WRITE_YIELD_MS.default),
});
export type TerminalWriteArgs = z.output<typeof TerminalWriteArgsSchema>;

export function parseTerminalWriteArgs(
  value: unknown,
): { ok: true; arguments: TerminalWriteArgs } | { ok: false; error: string } {
  const parsed = TerminalWriteArgsSchema.safeParse(value);
  return parsed.success
    ? { ok: true, arguments: parsed.data }
    : { ok: false, error: `Invalid terminal_write arguments: ${z.prettifyError(parsed.error)}` };
}

export const TerminalWaitArgsSchema = z.object({
  sessionId: z.string().min(1).max(128),
  observeOnly: z.boolean().optional(),
});
export type TerminalWaitArgs = z.output<typeof TerminalWaitArgsSchema>;

export function parseTerminalWaitArgs(
  value: unknown,
): { ok: true; arguments: TerminalWaitArgs } | { ok: false; error: string } {
  const parsed = TerminalWaitArgsSchema.safeParse(value);
  return parsed.success
    ? { ok: true, arguments: parsed.data }
    : { ok: false, error: `Invalid terminal_wait arguments: ${z.prettifyError(parsed.error)}` };
}

export const TerminalEndingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exited"), code: z.number().int() }),
  z.object({ kind: z.literal("signaled"), signal: z.string() }),
  z.object({ kind: z.literal("timed-out"), timeoutMs: z.number().int().positive() }),
  z.object({ kind: z.literal("killed") }),
  z.object({ kind: z.literal("stopped") }),
  z.object({ kind: z.literal("stop-failed"), reason: z.string() }),
  z.object({ kind: z.literal("not-started"), reason: z.string() }),
]);
export type TerminalEnding = z.infer<typeof TerminalEndingSchema>;

export const TerminalRunningOutcomeSchema = z.object({
  running: z.literal(true),
  sessionId: z.string(),
  output: z.string(),
  droppedBytes: z.number().int().nonnegative(),
  wallTimeMs: z.number().nonnegative(),
  notes: z.array(z.string()).optional(),
});
export type TerminalRunningOutcome = z.infer<typeof TerminalRunningOutcomeSchema>;

export const TerminalSettledOutcomeSchema = z.object({
  running: z.literal(false),
  sessionId: z.string(),
  output: z.string(),
  droppedBytes: z.number().int().nonnegative(),
  wallTimeMs: z.number().nonnegative(),
  ending: TerminalEndingSchema,
  pipesHeld: z.boolean(),
  backgroundRunning: z.boolean(),
  workingDirectory: z.string().optional(),
  notes: z.array(z.string()).optional(),
});
export type TerminalSettledOutcome = z.infer<typeof TerminalSettledOutcomeSchema>;

export const TerminalOutcomeSchema = z.discriminatedUnion("running", [
  TerminalRunningOutcomeSchema,
  TerminalSettledOutcomeSchema,
]);
export type TerminalOutcome = z.infer<typeof TerminalOutcomeSchema>;

export const TerminalWaitOutcomeSchema = z.discriminatedUnion("consumed", [
  z.object({ consumed: z.literal(true) }),
  z.object({ consumed: z.literal(false), outcome: TerminalSettledOutcomeSchema }),
]);
export type TerminalWaitOutcome = z.infer<typeof TerminalWaitOutcomeSchema>;

export const MemoryReadOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), content: z.string(), truncated: z.boolean() }),
  z.object({ status: z.literal("missing") }),
  z.object({ status: z.literal("unreadable"), message: z.string() }),
]);
export type MemoryReadOutcome = z.infer<typeof MemoryReadOutcomeSchema>;

/** What a tool call ends in, as the gateway hands it to its caller. */
export const ToolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
  isError: z.boolean(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

export function encodeTerminalOutcome(outcome: TerminalOutcome): ToolResult {
  const isError =
    !outcome.running &&
    outcome.ending.kind !== "killed" &&
    !(outcome.ending.kind === "exited" && outcome.ending.code === 0);
  return { content: [{ type: "text", text: JSON.stringify(outcome) }], isError };
}

export function decodeTerminalOutcome(
  result: ToolResult,
): { ok: true; outcome: TerminalOutcome } | { ok: false; error: string } {
  const text = result.content.map((part) => part.text).join("");
  try {
    const parsed = TerminalOutcomeSchema.safeParse(JSON.parse(text));
    if (parsed.success) return { ok: true, outcome: parsed.data };
  } catch {
    // Non-JSON text comes from gateway/node refusal or pre-flight validation errors.
  }
  return { ok: false, error: text };
}

export function encodeTerminalWaitOutcome(outcome: TerminalWaitOutcome): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(outcome) }], isError: false };
}

export function decodeTerminalWaitOutcome(
  result: ToolResult,
): { ok: true; outcome: TerminalWaitOutcome } | { ok: false; error: string } {
  const text = result.content.map((part) => part.text).join("");
  try {
    const parsed = TerminalWaitOutcomeSchema.safeParse(JSON.parse(text));
    if (parsed.success) return { ok: true, outcome: parsed.data };
  } catch {
    // Non-JSON text comes from gateway/node refusal or abort errors.
  }
  return { ok: false, error: text };
}

export function encodeMemoryReadOutcome(outcome: MemoryReadOutcome): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(outcome) }], isError: false };
}

export function decodeMemoryReadOutcome(
  result: ToolResult,
): { ok: true; outcome: MemoryReadOutcome } | { ok: false; error: string } {
  const text = result.content.map((part) => part.text).join("");
  try {
    const parsed = MemoryReadOutcomeSchema.safeParse(JSON.parse(text));
    if (parsed.success) return { ok: true, outcome: parsed.data };
  } catch {
    // Non-JSON text comes from gateway/node offline errors.
  }
  return { ok: false, error: text };
}

export function formatTerminalOutcome(outcome: TerminalOutcome): {
  text: string;
  isError: boolean;
} {
  const parts: string[] = [];
  if (outcome.output !== "") parts.push(outcome.output);
  if (outcome.droppedBytes > 0) {
    parts.push(
      `[Output truncated: the first ${outcome.droppedBytes} bytes were dropped; the last ${TERMINAL_KEPT_OUTPUT_BYTES} bytes are kept]`,
    );
  }
  if (outcome.notes !== undefined) {
    for (const note of outcome.notes) parts.push(note);
  }
  if (outcome.running) {
    parts.push(
      `[Command still running after ${outcome.wallTimeMs} ms; session_id: ${outcome.sessionId}]`,
    );
    return { text: parts.join("\n"), isError: false };
  }
  if (outcome.pipesHeld && outcome.ending.kind !== "stop-failed") {
    parts.push(
      "[Output may be incomplete: a background process still holds the output after the command exited]",
    );
  }
  if (outcome.backgroundRunning) {
    parts.push("[Background processes started by this command are still running]");
  }
  if (outcome.workingDirectory !== undefined) {
    parts.push(`[Working directory: ${outcome.workingDirectory}]`);
  }
  const ending = describeEnding(outcome.ending, outcome.sessionId);
  if (ending !== undefined) parts.push(ending);
  const text = parts.filter((part) => part !== "").join("\n");
  const isError =
    outcome.ending.kind !== "killed" &&
    !(outcome.ending.kind === "exited" && outcome.ending.code === 0);
  return { text: text === "" ? "(no output)" : text, isError };
}

function describeEnding(ending: TerminalEnding, sessionId: string): string | undefined {
  switch (ending.kind) {
    case "exited":
      return ending.code === 0 ? undefined : `Command exited with code ${ending.code}`;
    case "signaled":
      return `Command was killed by signal ${ending.signal}`;
    case "timed-out":
      return `Command timed out after ${ending.timeoutMs} ms and was killed`;
    case "killed":
      return "Command was killed";
    case "stopped":
      return "Command was stopped: its caller stopped it or the connection to the node dropped";
    case "stop-failed":
      return `Command could not be stopped; processes may still be running: ${ending.reason}\n[Retry with write_stdin, kill: true, session_id: ${sessionId}]`;
    case "not-started":
      return `Command could not start: ${ending.reason}`;
  }
}

// ── Workspace browsing ───────────────────────────────────────────────────────

/*
 * The limits keep every answer under the gateway's 1 MiB frame limit however the text escapes in JSON: a file's bytes
 * at most 6 bytes each (`\u0001`), an entry at most 255 name bytes at 6 each plus its fields.
 */
/** Bytes of a file a browse returns: the start. A longer file comes back truncated. */
export const BROWSE_FILE_BYTES = 128 * 1024;
/** Entries of a directory a browse returns. A larger directory comes back truncated. */
export const BROWSE_DIRECTORY_ENTRIES = 500;

/** A path to browse, as the file tools take one: relative to the workspace, or absolute inside it. */
export const WorkspacePathSchema = z.string().min(1).max(4096);

const DirectoryEntrySchema = z.discriminatedUnion("kind", [
  z.object({ name: z.string(), kind: z.literal("file"), size: z.number().int().nonnegative() }),
  z.object({ name: z.string(), kind: z.literal(["directory", "symlink"]) }),
]);

/**
 * What a browse found at a path, which is given relative to the workspace (`.` for the workspace itself): a
 * directory's entries by name, a text file's start, or a file that is not text.
 */
export const WorkspaceListingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("directory"),
    path: z.string(),
    entries: z.array(DirectoryEntrySchema).max(BROWSE_DIRECTORY_ENTRIES),
    /** More entries exist than `BROWSE_DIRECTORY_ENTRIES`; which of them are listed is up to the file system. */
    truncated: z.boolean(),
  }),
  z.object({
    kind: z.literal("file"),
    path: z.string(),
    size: z.number().int().nonnegative(),
    content: z.string(),
    /** `content` holds only the first `BROWSE_FILE_BYTES` bytes, ending on a whole character. */
    truncated: z.boolean(),
  }),
  z.object({ kind: z.literal("binary"), path: z.string(), size: z.number().int().nonnegative() }),
]);
export type WorkspaceListing = z.infer<typeof WorkspaceListingSchema>;

/**
 * How a node answers a browse. It refuses a path that leaves the workspace (`outside-workspace`, by `..`, an absolute
 * path elsewhere, or a symbolic link pointing out), a path or workspace that does not exist (`not-found`), and one it
 * cannot read, such as a FIFO or a file without permission (`unreadable`).
 */
export const NodeBrowseOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), listing: WorkspaceListingSchema }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["outside-workspace", "not-found", "unreadable"]),
    message: z.string(),
  }),
]);
export type NodeBrowseOutcome = z.infer<typeof NodeBrowseOutcomeSchema>;

// ── Node → Gateway (node sends these) ────────────────────────────────────────

export const NodeSystemSchema = z.object({
  platform: z.string(),
  arch: z.string(),
  hostname: z.string(),
  osRelease: z.string(),
  version: z.string(),
});
export type NodeSystem = z.infer<typeof NodeSystemSchema>;

export const NodeAuthenticateSchema = z.object({
  type: z.literal("node.authenticate"),
  requestId,
  nodeId,
  /** base64url-encoded Ed25519 signature of the challenge nonce. */
  signature: z.string().min(1),
  system: NodeSystemSchema,
  workspaceVisits: z.literal(true).optional(),
  tools: z.array(z.string().min(1).max(64)).max(64).optional(),
});

export const NodePairSchema = z.object({
  type: z.literal("node.pair"),
  requestId,
  nodeId,
  /** SPKI PEM-encoded Ed25519 public key. */
  publicKey: z.string().min(1),
  /** base64url-encoded Ed25519 signature of the challenge nonce. */
  signature: z.string().min(1),
  pairingToken: z.string().min(1),
  system: NodeSystemSchema,
  workspaceVisits: z.literal(true).optional(),
  tools: z.array(z.string().min(1).max(64)).max(64).optional(),
});

export const NodePingSchema = z.object({
  type: z.literal("node.ping"),
  requestId,
});

export const NodeToolOutputSchema = z.object({
  type: z.literal("node.tool.output"),
  requestId,
  /** Streaming text chunk; may be empty to signal progress. */
  chunk: z.string(),
});

export const NodeToolResultSchema = ToolResultSchema.extend({
  type: z.literal("node.tool.result"),
  requestId,
});

export const NodeBrowseResultSchema = z.object({
  type: z.literal("node.browse.result"),
  requestId,
  outcome: NodeBrowseOutcomeSchema,
});

export const NodeRequestSchema = z.discriminatedUnion("type", [
  NodeAuthenticateSchema,
  NodePairSchema,
  NodePingSchema,
  NodeToolOutputSchema,
  NodeToolResultSchema,
  NodeBrowseResultSchema,
]);

export type NodeRequest = z.infer<typeof NodeRequestSchema>;
export type NodeAuthenticate = z.infer<typeof NodeAuthenticateSchema>;
export type NodePair = z.infer<typeof NodePairSchema>;
export type NodePing = z.infer<typeof NodePingSchema>;
export type NodeToolOutput = z.infer<typeof NodeToolOutputSchema>;
export type NodeToolResult = z.infer<typeof NodeToolResultSchema>;
export type NodeBrowseResult = z.infer<typeof NodeBrowseResultSchema>;

// ── Gateway → Node (gateway sends these) ─────────────────────────────────────

export const GatewayChallengeSchema = z.object({
  type: z.literal("gateway.challenge"),
  /** base64url-encoded 32-byte random nonce; the node signs this. */
  nonce: z.string().min(1),
});

export const GatewayAuthenticatedSchema = z.object({
  type: z.literal("gateway.authenticated"),
  requestId,
  nodeId,
});

export const GatewayPairedSchema = z.object({
  type: z.literal("gateway.paired"),
  requestId,
  nodeId,
});

/**
 * The gateway refused who the node says it is. `unknown_identity` is the one refusal a node with a pairing token
 * answers by pairing; every other refusal, and `unknown_identity` without a token, is final: retrying cannot help.
 */
export const GatewayRefusedSchema = z.object({
  type: z.literal("gateway.refused"),
  requestId,
  code: z.enum(["unknown_identity", "invalid_identity", "pairing_rejected"]),
  message: z.string(),
});

/**
 * The gateway ended the connection for how it was used, not for who the node is: a node that sees this reconnects.
 */
export const GatewayErrorSchema = z.object({
  type: z.literal("gateway.error"),
  requestId: requestId.optional(),
  code: z.enum([
    "malformed_request",
    "not_authenticated",
    "already_authenticated",
    "handshake_timeout",
    "internal_error",
  ]),
  message: z.string(),
});

export const GatewayPongSchema = z.object({
  type: z.literal("gateway.pong"),
  requestId,
});

export const GatewayRunToolSchema = z.object({
  type: z.literal("gateway.run.tool"),
  /** Chosen by the gateway, unique per call; the call's output, result, and stop all carry it. */
  requestId,
  agentId,
  access: NodeAccessSchema,
  /** The calling conversation, numbered within its Agent, which keys the node's remembered command directory. Absent from an older control plane. */
  conversationId: z.number().int().nonnegative().optional(),
  tool: ToolNameSchema,
  arguments: z.record(z.string(), z.json()),
});

/** Stop one call: nobody waits for its result any more. */
export const GatewayStopToolSchema = z.object({
  type: z.literal("gateway.stop.tool"),
  /** The `requestId` of the `gateway.run.tool` to stop. */
  requestId,
});

export const GatewayPrepareWorkspaceSchema = z.object({
  type: z.literal("gateway.prepare.workspace"),
  requestId,
  agentId,
  access: NodeAccessSchema.default("home"),
});

/** Read a path in an Agent's workspace without changing anything; the node answers with `node.browse.result`. */
export const GatewayBrowseSchema = z.object({
  type: z.literal("gateway.browse"),
  requestId,
  agentId,
  path: WorkspacePathSchema,
});

export const GatewayMessageSchema = z.discriminatedUnion("type", [
  GatewayChallengeSchema,
  GatewayAuthenticatedSchema,
  GatewayPairedSchema,
  GatewayRefusedSchema,
  GatewayErrorSchema,
  GatewayPongSchema,
  GatewayRunToolSchema,
  GatewayStopToolSchema,
  GatewayPrepareWorkspaceSchema,
  GatewayBrowseSchema,
]);

export type GatewayMessage = z.infer<typeof GatewayMessageSchema>;
export type GatewayChallenge = z.infer<typeof GatewayChallengeSchema>;
export type GatewayAuthenticated = z.infer<typeof GatewayAuthenticatedSchema>;
export type GatewayPaired = z.infer<typeof GatewayPairedSchema>;
export type GatewayRefused = z.infer<typeof GatewayRefusedSchema>;
export type GatewayError = z.infer<typeof GatewayErrorSchema>;
export type GatewayPong = z.infer<typeof GatewayPongSchema>;
export type GatewayRunTool = z.infer<typeof GatewayRunToolSchema>;
export type GatewayStopTool = z.infer<typeof GatewayStopToolSchema>;
export type GatewayPrepareWorkspace = z.infer<typeof GatewayPrepareWorkspaceSchema>;
export type GatewayBrowse = z.infer<typeof GatewayBrowseSchema>;
