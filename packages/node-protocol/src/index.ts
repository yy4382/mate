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

// ── Node → Gateway (node sends these) ────────────────────────────────────────

export const NodeAuthenticateSchema = z.object({
  type: z.literal("node.authenticate"),
  requestId,
  nodeId,
  /** base64url-encoded Ed25519 signature of the challenge nonce. */
  signature: z.string().min(1),
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

export const NodeRequestSchema = z.discriminatedUnion("type", [
  NodeAuthenticateSchema,
  NodePairSchema,
  NodePingSchema,
  NodeToolOutputSchema,
  NodeToolResultSchema,
]);

export type NodeRequest = z.infer<typeof NodeRequestSchema>;
export type NodeAuthenticate = z.infer<typeof NodeAuthenticateSchema>;
export type NodePair = z.infer<typeof NodePairSchema>;
export type NodePing = z.infer<typeof NodePingSchema>;
export type NodeToolOutput = z.infer<typeof NodeToolOutputSchema>;
export type NodeToolResult = z.infer<typeof NodeToolResultSchema>;

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
