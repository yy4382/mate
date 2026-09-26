import { NodeRequestSchema } from "./protocol.js";

const RESULT_TEXT_LIMIT = 12_000;

/** Keep workspace helper output inside its wire limits and never leak send failures as rejections. */
export function sendWorkspaceOperationResult(
  send: (request: unknown) => void,
  metadata: {
    requestId: string;
    operationId: string;
    agentId: string;
    revision?: number;
  },
  result: { code: number; stdout: string; stderr: string; truncated: boolean },
): void {
  const stdout = result.stdout.slice(0, RESULT_TEXT_LIMIT),
    stderr = result.stderr.slice(0, RESULT_TEXT_LIMIT),
    truncated =
      result.truncated ||
      stdout.length !== result.stdout.length ||
      stderr.length !== result.stderr.length;
  try {
    send(
      NodeRequestSchema.parse({
        type: "node.workspace.operation.result",
        ...metadata,
        ok: true,
        result: {
          code: result.code,
          stdout,
          stderr,
          truncated,
          ...(metadata.revision === undefined ? {} : { revision: metadata.revision }),
        },
      }),
    );
  } catch {
    try {
      send(
        NodeRequestSchema.parse({
          type: "node.workspace.operation.result",
          ...metadata,
          ok: false,
          error: "Linux workspace operation result could not be sent",
        }),
      );
    } catch {
      // A closed or broken socket cannot carry even the bounded fallback response.
    }
  }
}
