import { z } from "zod";
import { workspaceFailureCodeSchema, type WorkspaceFailureCode } from "@mate/protocol";
import { systemErrorCode } from "../system-error.js";

// Even JSON's worst-case escaping keeps this below the backend's 64 KiB stderr capture.
const helperDiagnosticMaxChars = 4_096;
export const helperFailureSchema = z
  .object({
    errorCode: workspaceFailureCodeSchema,
    message: z.string().max(helperDiagnosticMaxChars),
  })
  .strict();

/** Mate-owned file checks carry a code at the point that knows why they failed. */
export class FileOperationError extends Error {
  constructor(
    readonly errorCode: WorkspaceFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "FileOperationError";
  }
}

export function fileFailure(error: unknown) {
  let errorCode: WorkspaceFailureCode = "workspace_unavailable";
  if (error instanceof FileOperationError) errorCode = error.errorCode;
  else {
    switch (systemErrorCode(error)) {
      case "EACCES":
      case "EPERM":
        errorCode = "permission_denied";
        break;
      case "ENOENT":
        errorCode = "not_found";
        break;
      case "EISDIR":
        errorCode = "not_file";
        break;
      case "ELOOP":
        errorCode = "unsafe_path";
        break;
    }
  }
  return helperFailureSchema.parse({
    errorCode,
    message: (error instanceof Error ? error.message : "File operation failed").slice(
      0,
      helperDiagnosticMaxChars,
    ),
  });
}
