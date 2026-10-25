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
 * The workspace tools a node runs. `read`, `write` and `edit` are Durable's own tools of those names, executed on the
 * node's filesystem; `bash` is the node's own, defined below.
 */
export const ToolNameSchema = z.enum(["bash", "read", "write", "edit"]);
export type ToolName = z.infer<typeof ToolNameSchema>;

// ── The bash tool ────────────────────────────────────────────────────────────

/** Bytes of a command's combined output its result keeps: the tail. Earlier output is dropped and the result says so. */
export const BASH_KEPT_OUTPUT_BYTES = 50 * 1024;

/**
 * A command's timeout in seconds, by how it runs: the one it gets when the call names none, and the most it may ask
 * for. A foreground command holds up its conversation, so it always has a limit.
 */
export const BASH_TIMEOUT_SECONDS = {
  foreground: { default: 10 * 60, max: 60 * 60 },
  background: { default: undefined, max: 24 * 60 * 60 },
} as const;

const { foreground, background } = BASH_TIMEOUT_SECONDS;

/**
 * The arguments of the node's `bash` tool. The runtime shows the model this schema and parses calls with it, and the
 * node parses them again with it, so what the model is promised, the defaults, and what the node does come from one
 * place. Parsing applies the mode's default timeout; parsing the result again changes nothing.
 */
const BashArgumentsSchema = z
  .object({
    command: z.string().describe("The command, run verbatim by /bin/sh -c"),
    timeout: z
      .number()
      .positive()
      .max(background.max)
      .optional()
      .describe(
        `Timeout in seconds. In the foreground ${foreground.default} when omitted and at most ${foreground.max}; in ` +
          `the background none when omitted and at most ${background.max}. On timeout every process the command ` +
          "started is killed",
      ),
    background: z
      .boolean()
      .optional()
      .describe(
        "Run the command in the background: bash returns a command ID at once and you keep working; the command's " +
          "result arrives as a new input when it ends. Stop it with bash_stop",
      ),
  })
  .refine(
    (call) =>
      call.background === true || call.timeout === undefined || call.timeout <= foreground.max,
    {
      message: `A foreground command's timeout is at most ${foreground.max} seconds`,
      path: ["timeout"],
    },
  )
  .transform(({ command, timeout, background: inBackground = false }) => {
    const effective =
      timeout ?? BASH_TIMEOUT_SECONDS[inBackground ? "background" : "foreground"].default;
    return {
      command,
      background: inBackground,
      ...(effective === undefined ? {} : { timeout: effective }),
    };
  });
export type BashArguments = z.output<typeof BashArgumentsSchema>;

/** A `bash` call's arguments with its mode's default timeout applied, or why they are invalid. */
export function parseBashArguments(
  value: unknown,
): { ok: true; arguments: BashArguments } | { ok: false; error: string } {
  const parsed = BashArgumentsSchema.safeParse(value);
  return parsed.success
    ? { ok: true, arguments: parsed.data }
    : { ok: false, error: `Invalid bash arguments: ${z.prettifyError(parsed.error)}` };
}

const { $schema: _, ...bashParameters } = z.toJSONSchema(BashArgumentsSchema, { io: "input" });

/** The `bash` tool as the model sees it: its name, what it does, and its parameters as JSON Schema. */
export const bashTool = {
  name: "bash",
  description:
    "Run a shell command with /bin/sh -c in your workspace, which is both the working directory and HOME. Returns " +
    `the combined stdout and stderr; only the last ${BASH_KEPT_OUTPUT_BYTES / 1024}KB are kept, and the result says ` +
    "how much was dropped before them. A nonzero exit, a kill by signal, and a timeout are errors. When the command " +
    "returns while processes it started in the background still run, the result says so; if they still hold the " +
    "output, it returns about a second after the command and says the output may be incomplete. You wait for a " +
    `foreground command, ${foreground.default / 60} minutes at most unless you give a timeout; run a long command ` +
    "with background: true instead and keep working.",
  parameters: bashParameters,
} as const;

/** What a tool call ends in, as the gateway hands it to its caller. */
export const ToolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal("text"), text: z.string() })).min(1),
  isError: z.boolean(),
});
export type ToolResult = z.infer<typeof ToolResultSchema>;

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
