import {
  workspaceFailureCodeSchema,
  NodeRequestSchema,
  type NodeWorkspaceOperationResult,
} from "@mate/protocol";

type WorkspaceOperationSuccess = Extract<NodeWorkspaceOperationResult, { ok: true }>;

const RESULT_TEXT_LIMIT = 12_000;

/** Keep workspace helper output inside its wire limits and never leak send failures as rejections. */
export function sendWorkspaceOperationResult(
  send: (request: unknown) => void,
  metadata: Pick<WorkspaceOperationSuccess, "requestId" | "operationId" | "agentId" | "revision">,
  result: WorkspaceOperationSuccess["result"],
): void {
  const stdout = result.stdout.slice(0, RESULT_TEXT_LIMIT),
    stderr = result.stderr.slice(0, RESULT_TEXT_LIMIT),
    truncated =
      result.truncated ||
      stdout.length !== result.stdout.length ||
      stderr.length !== result.stderr.length;
  const errorCode = workspaceFailureCodeSchema.safeParse(result.errorCode);
  try {
    send(
      NodeRequestSchema.parse({
        type: "node.workspace.operation.result",
        ...metadata,
        ok: true,
        result: {
          code: result.code,
          ...(errorCode.success ? { errorCode: errorCode.data } : {}),
          stdout,
          stderr,
          truncated,
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
